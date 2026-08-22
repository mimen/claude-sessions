/**
 * Live ground-truth comparator: a loopback web app that re-runs the oracles forever and
 * shows tracked state vs reality as it changes.
 *
 * Every discrepancy becomes a keyed condition tracked across sweeps, so persistent drift is
 * distinguishable from a one-sweep race at a glance: age and consecutive-sweep count rise
 * together for real drift, while races appear and resolve within a cycle or two.
 *
 * Read-only against live state. bun run scripts/sidebar-ground-truth-live.ts [port]
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGUE_PATH, DB_PATH } from "../src/paths.ts";
import { scanStore } from "../src/store.ts";
import { readIndexReadOnly } from "../src/sidebar/index-read.ts";
import {
  auditAgentActivity,
  auditCoverage,
  auditDirectories,
  auditHookBindings,
  auditSurfaceTree,
  auditTranscriptRows,
  CLAUDE_STORE,
  RECENT_WINDOW_MS,
  type Finding,
} from "./sidebar-ground-truth-lib.ts";

const PORT = Number(process.argv[2] ?? 8793);
const FAST_CYCLE_MS = 3_000;
const ACTIVITY_EVERY_N_CYCLES = 5;

interface Condition {
  key: string;
  primitive: string;
  severity: Finding["severity"];
  detail: string;
  firstSeen: number;
  lastSeen: number;
  sweeps: number;
  active: boolean;
}

interface ResolvedCondition extends Condition {
  resolvedAt: number;
}

const conditions = new Map<string, Condition>();
const recentlyResolved: ResolvedCondition[] = [];
let cycles = 0;
let lastSweepAt = 0;
let lastActivitySweepAt = 0;
let sweeping = false;

function absorb(found: readonly Finding[]): void {
  const seen = new Set<string>();
  for (const f of found) {
    if (!f.key) continue;
    seen.add(f.key);
    const existing = conditions.get(f.key);
    if (existing && existing.active) {
      existing.lastSeen = Date.now();
      existing.sweeps += 1;
      existing.detail = f.detail;
    } else if (existing) {
      // Recurred after resolving: continue its history rather than resetting it.
      existing.active = true;
      existing.lastSeen = Date.now();
      existing.sweeps += 1;
      existing.detail = f.detail;
    } else {
      conditions.set(f.key, {
        key: f.key,
        primitive: f.primitive,
        severity: f.severity,
        detail: f.detail,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        sweeps: 1,
        active: true,
      });
    }
  }
  for (const c of conditions.values()) {
    if (c.active && !seen.has(c.key)) {
      c.active = false;
      recentlyResolved.unshift({ ...c, resolvedAt: Date.now() });
      if (recentlyResolved.length > 40) recentlyResolved.pop();
    }
  }
}

async function timedCycle(includeActivity: boolean): Promise<void> {
  const nowMs = Date.now();
  const cycleFindings: Finding[] = [];

  const tree = await auditSurfaceTree();
  cycleFindings.push(...tree.findings);

  const hooks = await auditHookBindings(tree.facts);
  cycleFindings.push(...hooks.findings);

  if (includeActivity) {
    cycleFindings.push(...(await auditAgentActivity(tree.facts, hooks.facts)));
    lastActivitySweepAt = Date.now();
  }

  let indexRows: ReturnType<typeof readIndexReadOnly> = [];
  try {
    indexRows = readIndexReadOnly(DB_PATH(), { limit: 200 });
  } catch {
    // The transcript-facts checks simply skip this cycle when the index is unreadable.
  }
  cycleFindings.push(...auditTranscriptRows(indexRows));
  cycleFindings.push(...catalogueOrphanFindings());
  cycleFindings.push(...coverageFindings(indexRows, nowMs));
  cycleFindings.push(...(await auditDirectories(indexRows)));

  absorb(cycleFindings);
  cycles += 1;
  lastSweepAt = Date.now();
}

function coverageFindings(
  indexRows: ReturnType<typeof readIndexReadOnly>,
  nowMs: number,
): Finding[] {
  try {
    const scanned = scanStore(CLAUDE_STORE);
    if (!scanned.ok) return [];
    const ids = new Set(indexRows.map((r) => r.sessionId));
    try {
      const db = new Database(DB_PATH(), { readonly: true });
      const rows = db
        .query("SELECT session_id, resume_id FROM sessions")
        .all() as Array<{ session_id: string; resume_id: string | null }>;
      for (const r of rows) {
        ids.add(r.session_id);
        if (r.resume_id) ids.add(r.resume_id);
      }
      db.close();
    } catch {
      // fall back to the sampled id set
    }
    const recentFiles = new Map<string, { path: string; mtimeMs: number }>();
    for (const f of scanned.value) {
      if (nowMs - f.mtimeMs < RECENT_WINDOW_MS) {
        recentFiles.set(f.sessionId, { path: f.path, mtimeMs: f.mtimeMs });
      }
    }
    return auditCoverage({ indexedIds: ids, recentFiles, nowMs });
  } catch {
    return [];
  }
}

function catalogueOrphanFindings(): Finding[] {
  try {
    const db = new Database(CATALOGUE_PATH(), { readonly: true });
    const rows = db
      .query("SELECT session_id FROM catalogue")
      .all() as Array<{ session_id: string }>;
    db.close();
    const scanned = scanStore(CLAUDE_STORE);
    if (!scanned.ok) return [];
    const onDisk = new Set(scanned.value.map((f) => f.sessionId));
    const out: Finding[] = [];
    let orphans = 0;
    for (const r of rows) {
      if (!onDisk.has(r.session_id)) {
        orphans += 1;
        out.push({
          primitive: "catalogue-identity",
          severity: "warn",
          detail: `catalogue row ${r.session_id} has no transcript file on disk`,
          key: `catalogue-orphan:${r.session_id}`,
        });
      }
    }
    if (rows.length > 0 || orphans === 0) {
      out.push({
        primitive: "catalogue-identity",
        severity: "info",
        detail: `${orphans}/${rows.length} catalogue rows have no transcript on disk`,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function sweepLoop(): Promise<void> {
  while (true) {
    if (!sweeping) {
      sweeping = true;
      try {
        await timedCycle(cycles % ACTIVITY_EVERY_N_CYCLES === 0);
      } catch {
        // A failed cycle leaves the previous conditions standing; the next one retries.
      } finally {
        sweeping = false;
      }
    }
    await Bun.sleep(FAST_CYCLE_MS);
  }
}

interface StatePayload {
  now: number;
  cycles: number;
  sweeping: boolean;
  lastSweepAt: number;
  lastActivitySweepAt: number;
  store: string;
  active: Condition[];
  resolved: ResolvedCondition[];
}

function statePayload(): StatePayload {
  const active = [...conditions.values()]
    .filter((c) => c.active)
    .sort((a, b) => a.firstSeen - b.firstSeen);
  return {
    now: Date.now(),
    cycles,
    sweeping,
    lastSweepAt,
    lastActivitySweepAt,
    store: CLAUDE_STORE,
    active,
    resolved: recentlyResolved.slice(0, 12),
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sidebar ground truth — live</title>
<style>
  :root{--bg:#101216;--card:#181b21;--line:#262a33;--ink:#dfe3ea;--dim:#8a919e;
        --ok:#2fae7d;--bad:#e5534b;--warn:#d29922;--mono:"SF Mono",ui-monospace,Menlo,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,"SF Pro Text",sans-serif}
  header{display:flex;align-items:center;gap:14px;padding:14px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:1}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--ok);animation:pulse 1.6s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  header h1{font-size:15px;margin:0;font-weight:600}
  header .meta{color:var(--dim);font-size:12px;font-family:var(--mono)}
  main{padding:18px 22px 60px;max-width:1100px;margin:0 auto}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .card h2{margin:0 0 2px;font-size:14px;display:flex;justify-content:space-between;align-items:center}
  .badge{font-size:10.5px;padding:2px 9px;border-radius:99px;font-weight:600;letter-spacing:.04em}
  .ok{background:rgba(47,174,125,.15);color:var(--ok)}
  .bad{background:rgba(229,83,75,.15);color:var(--bad)}
  .pending{background:var(--line);color:var(--dim)}
  .tracks{color:var(--dim);font-size:12px;margin:2px 0 10px}
  ul{list-style:none;margin:0;padding:0}
  li{display:flex;gap:8px;padding:5px 0;border-top:1px solid var(--line);font-size:12.5px;align-items:baseline}
  .sev{width:7px;height:7px;border-radius:50%;flex:none;position:relative;top:-1px}
  .sev.error{background:var(--bad)} .sev.warn{background:var(--warn)}
  .age{font-family:var(--mono);color:var(--dim);flex:none;font-size:11px;min-width:74px;text-align:right}
  .detail{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  .clean{color:var(--dim);font-size:12.5px;font-style:italic}
  h3{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:26px 0 8px}
  .resolved li{color:var(--dim)}
  footer{margin-top:30px;color:var(--dim);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px;line-height:1.8}
</style>
</head>
<body>
<header>
  <div class="dot" id="dot"></div>
  <h1>Sidebar ground truth</h1>
  <span class="meta" id="meta">connecting…</span>
</header>
<main>
  <div class="grid" id="grid"></div>
  <h3>Recently resolved (races heal here)</h3>
  <ul class="resolved card" id="resolved" style="list-style:none"></ul>
  <footer>
    Spot-checks only you can run: count your open cmux tabs vs the surface count · give an agent
    a task that ends needing you and watch the flip land within ~3s · click any row and confirm
    the focused tab holds exactly that session. If those hold but this board shows drift, the
    tracking is wrong; if this board is clean but the sidebar reads stale, delivery/redraw is.
  </footer>
</main>
<script>
const PRIMS = ["surface-tree","hook-bindings","agent-activity","transcript-facts","coverage","catalogue-identity","directory-facts"];
const TRACKS = {
  "surface-tree":"which cmux workspaces and surfaces exist right now",
  "hook-bindings":"which claude session lives on which surface, alive or not",
  "agent-activity":"whether each agent is running or waiting for you",
  "transcript-facts":"message counts, sizes, recency from the session index",
  "coverage":"whether recent transcripts reached the index at all",
  "catalogue-identity":"the durable registry of sessions",
  "directory-facts":"the project directory behind each row"
};
function ago(t){return Math.max(0,Math.round((Date.now()-t)/1000));}
function fmtAge(s){return s<60?s+"s":s<3600?Math.floor(s/60)+"m":Math.floor(s/3600)+"h"+Math.floor((s%3600)/60)+"m";}
let lastData=null;
async function tick(){
  try{
    const r=await fetch("/api/state");lastData=await r.json();render(lastData);
  }catch(e){document.getElementById("meta").textContent="server unreachable";document.getElementById("dot").style.background="#e5534b";}
}
function render(d){
  document.getElementById("dot").style.background=d.sweeping?"#d29922":"#2fae7d";
  document.getElementById("meta").textContent=
    "cycle "+d.cycles+" · last sweep "+ago(d.lastSweepAt)+"s ago · activity "+ago(d.lastActivitySweepAt)+"s ago · "+d.active.length+" open drifts";
  const byPrim={};for(const c of d.active){(byPrim[c.primitive]??=[]).push(c);}
  const g=document.getElementById("grid");g.innerHTML="";
  for(const p of PRIMS){
    const cs=byPrim[p]||[];
    const badge=cs.length===0?'<span class="badge ok">MATCHES REALITY</span>'
      :'<span class="badge bad">DRIFTED ×'+cs.length+"</span>";
    let lis="";
    for(const c of cs.slice(0,8)){
      lis+='<li><span class="sev '+c.severity+'"></span><span class="detail" title="'+esc(c.detail)+'">'+esc(shorten(c.key))+
        '</span><span class="age">'+fmtAge(ago(c.firstSeen))+" · "+c.sweeps+"×</span></li>";
    }
    if(cs.length>8)lis+='<li><span class="detail" style="color:var(--dim)">…and '+(cs.length-8)+" more</span></li>";
    if(cs.length===0)lis='<li class="clean">no drift observed</li>';
    const div=document.createElement("div");div.className="card";
    div.innerHTML="<h2>"+p+" "+badge+"</h2><div class=\\"tracks\\">"+TRACKS[p]+"</div><ul>"+lis+"</ul>";
    g.appendChild(div);
  }
  const res=document.getElementById("resolved");res.innerHTML="";
  if(d.resolved.length===0)res.innerHTML='<li class="clean">nothing has resolved yet</li>';
  for(const c of d.resolved){
    const li=document.createElement("li");
    li.innerHTML='<span class="detail">'+esc(shorten(c.key))+'</span><span class="age">lived '+fmtAge(Math.round((c.resolvedAt-c.firstSeen)/1000))+"</span>";
    res.appendChild(li);
  }
}
function shorten(k){return k.replace(/^[a-z-]+:/,"").slice(0,42);}
function esc(s){return s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");}
tick();setInterval(tick,1000);
</script>
</body>
</html>`;

mkdirSync(join(import.meta.dir, "..", "docs", "evidence", "sidebar-ground-truth"), { recursive: true });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/state") {
      return Response.json(statePayload());
    }
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }
    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
});

process.stdout.write(`sidebar ground truth live at http://127.0.0.1:${PORT}/\n`);
void sweepLoop();

export { server };
