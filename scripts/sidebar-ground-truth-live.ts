/**
 * Live ground-truth comparator: a loopback web app that mirrors what ccs tracks next to
 * directly measured reality, refreshed forever.
 *
 * The unit of display is the SESSION ROW, not the discrepancy: each row shows what cmux's
 * hook store claims about a session beside fresh measurements (tree membership, ps on the
 * claimed pid, the filesystem, cmux's own status pill), with per-cell agreement. Rows whose
 * claims contradict measurements highlight and collect under Ghosts; everything else is a
 * mirror a human can spot-check against their own open tabs.
 *
 * Read-only against live state. bun run scripts/sidebar-ground-truth-live.ts [port]
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { CATALOGUE_PATH, DB_PATH } from "../src/paths.ts";
import { scanStore } from "../src/store.ts";
import { readIndexReadOnly } from "../src/sidebar/index-read.ts";
import { subscribeToCmuxEvents } from "../src/cmux/events.ts";
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
import { statusFromAgentLifecycle } from "../src/sidebar/status.ts";

const PORT = Number(process.argv[2] ?? 8793);
const FAST_CYCLE_MS = 3_000;
const ACTIVITY_EVERY_N_CYCLES = 5;

// --- condition ledger (secondary evidence; the mirror is the primary display) -------

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

function absorb(found: readonly Finding[]): void {
  const seen = new Set<string>();
  for (const f of found) {
    if (!f.key) continue;
    seen.add(f.key);
    const existing = conditions.get(f.key);
    if (existing?.active) {
      existing.lastSeen = Date.now();
      existing.sweeps += 1;
      existing.detail = f.detail;
    } else if (existing) {
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

// --- the mirror ----------------------------------------------------------------------

export interface MirrorRow {
  sessionId: string;
  title: string | null;
  surfaceId: string | null;
  /** The tab's own name (the surface title cmux shows on the pane). */
  surfaceTitle: string | null;
  /** The workspace's name as cmux displays it on the tab bar. */
  workspaceTitle: string | null;
  workspaceRef: string | null;
  trackedLifecycle: string | null;
  surfaceInTree: boolean;
  /** cmux's own pointer: this surface's workspace is the one currently focused. */
  workspaceFocused: boolean;
  pidAlive: boolean | null;
  transcriptState: "present" | "renamed" | "absent";
  authoritativePill: string | null;
  derivedLabel: string | null;
}

export interface Mirror {
  live: MirrorRow[];
  ghosts: MirrorRow[];
  unboundSurfaces: Array<{ workspaceRef: string; title: string | null }>;
}

function buildMirror(
  treeFacts: Awaited<ReturnType<typeof auditSurfaceTree>>["facts"],
  hooksFacts: Awaited<ReturnType<typeof auditHookBindings>>["facts"],
  pillsByWorkspace: Map<string, string>,
  titlesBySession: Map<string, string>,
): Mirror {
  const surfaceById = new Map(treeFacts.surfaces.map((s) => [s.surfaceId, s]));
  const boundSurfaceIds = new Set<string>();
  const rows: MirrorRow[] = [];
  for (const [, entry] of hooksFacts.sessions) {
    const sessionId = entry.sessionId ?? null;
    if (!sessionId) continue;
    const surfaceId = entry.surfaceId ?? null;
    const surface = surfaceId !== null ? surfaceById.get(surfaceId) : undefined;
    if (surface !== undefined) boundSurfaceIds.add(surfaceId ?? "");
    rows.push({
      sessionId,
      title: titlesBySession.get(sessionId) ?? null,
      surfaceId,
      surfaceTitle: surface?.title ?? null,
      workspaceTitle: surface?.workspaceTitle ?? null,
      workspaceRef: surface?.workspaceRef ?? null,
      trackedLifecycle: entry.agentLifecycle ?? null,
      surfaceInTree: surface !== undefined,
      workspaceFocused: surface?.workspaceActive === true,
      pidAlive: hooksFacts.pidLiveness.get(sessionId) ?? null,
      transcriptState: hooksFacts.transcriptPresence.get(sessionId) ?? "absent",
      authoritativePill: surface ? pillsByWorkspace.get(surface.workspaceId) ?? null : null,
      derivedLabel: statusFromAgentLifecycle(entry.agentLifecycle ?? null)?.label ?? null,
    });
  }

  const discrepanciesOf = (r: MirrorRow): number =>
    (r.surfaceInTree ? 0 : 1) +
    (r.pidAlive === false ? 1 : 0) +
    (r.transcriptState === "absent" ? 1 : 0);

  // Live rows follow the TREE's traversal order — window → workspace → pane — which is the
  // order cmux displays them in, so the mirror is comparable against the tab bar. The hook
  // store's own iteration order is irrelevant here.
  const orderInTree = new Map(treeFacts.surfaces.map((s, i) => [s.surfaceId, i]));
  const live = rows
    .filter((r) => r.surfaceInTree)
    .sort(
      (a, b) =>
        (orderInTree.get(a.surfaceId ?? "") ?? Number.MAX_SAFE_INTEGER) -
        (orderInTree.get(b.surfaceId ?? "") ?? Number.MAX_SAFE_INTEGER),
    );
  const ghosts = rows.filter((r) => !r.surfaceInTree).sort((a, b) => discrepanciesOf(b) - discrepanciesOf(a));

  const unboundSurfaces = treeFacts.surfaces
    .filter((s) => !boundSurfaceIds.has(s.surfaceId))
    .map((s) => ({ workspaceRef: s.workspaceRef, title: s.workspaceTitle }));

  return { live, ghosts, unboundSurfaces };
}

// --- sweep loop -----------------------------------------------------------------------

let cycles = 0;
let lastSweepAt = 0;
let lastActivitySweepAt = 0;
let sweeping = false;
let pillsByWorkspace = new Map<string, string>();
let latestMirror: Mirror = { live: [], ghosts: [], unboundSurfaces: [] };

async function timedCycle(includeActivity: boolean): Promise<void> {
  const nowMs = Date.now();
  const cycleFindings: Finding[] = [];

  const tree = await auditSurfaceTree();
  cycleFindings.push(...tree.findings);

  const hooks = await auditHookBindings(tree.facts);
  cycleFindings.push(...hooks.findings);

  // Pills survive between authoritative sweeps: an unswept workspace keeps its last
  // measurement rather than regressing to "not swept yet" every fast cycle.
  if (includeActivity) {
    const activity = await auditAgentActivity(tree.facts, hooks.facts);
    cycleFindings.push(...activity.findings);
    pillsByWorkspace = activity.pillsByWorkspace;
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

  const titlesBySession = new Map<string, string>();
  for (const row of indexRows) {
    if (row.title) titlesBySession.set(row.sessionId, row.title);
  }
  latestMirror = buildMirror(tree.facts, hooks.facts, pillsByWorkspace, titlesBySession);
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
        // A failed cycle leaves the previous mirror standing; the next one retries.
      } finally {
        sweeping = false;
      }
    }
    await Bun.sleep(FAST_CYCLE_MS);
  }
}

/**
 * Event-driven fast path: cmux announces window/workspace/agent changes on its event stream,
 * and focus is a window-category change. One kick runs an immediate cycle so the highlight
 * tracks tab switches in tens of milliseconds rather than one poll interval. The 3s loop
 * remains as the fallback that catches whatever the stream misses.
 */
let lastKickAt = 0;
const KICK_MIN_INTERVAL_MS = 250;

function startEventKicker(): void {
  subscribeToCmuxEvents({
    onChange(scopes) {
      if (!scopes.has("liveness")) return;
      const now = Date.now();
      if (now - lastKickAt < KICK_MIN_INTERVAL_MS || sweeping) return;
      lastKickAt = now;
      void timedCycle(cycles % ACTIVITY_EVERY_N_CYCLES === 0).catch(() => {});
    },
  });
}

interface StatePayload {
  now: number;
  cycles: number;
  sweeping: boolean;
  lastSweepAt: number;
  lastActivitySweepAt: number;
  store: string;
  mirror: Mirror;
  driftCount: number;
  resolved: ResolvedCondition[];
}

function statePayload(): StatePayload {
  return {
    now: Date.now(),
    cycles,
    sweeping,
    lastSweepAt,
    lastActivitySweepAt,
    store: CLAUDE_STORE,
    mirror: latestMirror,
    driftCount: [...conditions.values()].filter((c) => c.active).length,
    resolved: recentlyResolved.slice(0, 12),
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sidebar ground truth — live mirror</title>
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
  main{padding:18px 22px 60px;max-width:1250px;margin:0 auto}
  h3{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:26px 0 8px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;font-size:12.5px}
  th{text-align:left;color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;padding:9px 12px;border-bottom:1px solid var(--line)}
  td{padding:7px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .v{font-family:var(--mono)}
  .cell-yes{color:var(--ok)} .cell-no{color:var(--bad)} .cell-na{color:var(--dim)}
  .row-bad td{background:rgba(229,83,75,.06)}
  tr.focused td{border-left:3px solid var(--ok);background:rgba(47,174,125,.07)}
  tr.focused td:first-child{padding-left:9px}
  .title{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .name{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
  .k{display:inline-block;min-width:44px;color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
  .foc{color:var(--ok);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
  .sid{color:var(--dim);font-family:var(--mono);font-size:10.5px}
  .pillchip{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);background:var(--line);white-space:nowrap}
  footer{margin-top:30px;color:var(--dim);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px;line-height:1.8}
  .legend{color:var(--dim);font-size:12px;margin:4px 0 14px}
</style>
</head>
<body>
<header>
  <div class="dot" id="dot"></div>
  <h1>Sidebar ground truth — live mirror</h1>
  <span class="meta" id="meta">connecting…</span>
</header>
<main>
  <h3>Live surfaces — what cmux binds, measured fresh</h3>
  <div class="legend">Each cell is an independent measurement, not another tracked claim. Check any row against your own tabs.</div>
  <table><thead><tr>
    <th>Session</th><th>In tree</th><th>Pill (cmux)</th><th>Hooks say</th><th>Pid alive</th><th>Transcript</th>
  </tr></thead><tbody id="live"></tbody></table>

  <h3>Ghosts — tracked by the hook store, contradicted by measurements</h3>
  <table><thead><tr>
    <th>Session</th><th>Claims</th><th>Surface in tree</th><th>Pid alive</th><th>Transcript on disk</th>
  </tr></thead><tbody id="ghosts"></tbody></table>

  <h3>Unbound surfaces — exist in cmux but no session claims them</h3>
  <div class="legend" id="unbound">…</div>

  <footer>
    How to verify a row by hand: the <b>tree</b> cell says whether that surface really exists among your open
    cmux workspaces; the <b>pid</b> cell is the kernel's answer to "is that claude process alive"; the
    <b>transcript</b> cell is the filesystem's. If a live row here and your actual tab disagree, tracking is
    wrong — note the row's session id. If everything agrees but the real sidebar still reads stale, the bug
    is delivery/redraw, not data.
  </footer>
</main>
<script>
function ago(t){return Math.max(0,Math.round((Date.now()-t)/1000));}
async function tick(){
  try{
    const r=await fetch("/api/state");const d=await r.json();render(d);
  }catch(e){document.getElementById("meta").textContent="server unreachable";
    document.getElementById("dot").style.background="#e5534b";}
}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");}
function yn(b){return b===null?'<span class="cell-na">—</span>':b?'<span class="cell-yes">✓ yes</span>':'<span class="cell-no">✗ no</span>';}
function tstate(s){return s==="present"?'<span class="cell-yes">✓ on disk</span>'
  :s==="renamed"?'<span class="cell-na">renamed</span>':'<span class="cell-no">✗ gone</span>';}
function render(d){
  document.getElementById("dot").style.background=d.sweeping?"#d29922":"#2fae7d";
  document.getElementById("meta").textContent=
    "cycle "+d.cycles+" · last sweep "+ago(d.lastSweepAt)+"s ago · activity pill "+ago(d.lastActivitySweepAt)+"s ago · "+
    d.mirror.live.length+" live / "+d.mirror.ghosts.length+" ghosts · "+d.driftCount+" ledger drifts";
  const live=document.getElementById("live");live.innerHTML="";
  for(const r of d.mirror.live){
    const bad=(r.authoritativePill&&r.derivedLabel&&r.authoritativePill!==r.derivedLabel)||r.transcriptState==="absent";
    const tr=document.createElement("tr");if(bad)tr.className="row-bad";if(r.workspaceFocused)tr.classList.add("focused");
    tr.innerHTML='<td><div class="name"><span class="k">tab</span> '+esc(r.surfaceTitle||"(unnamed)")+(r.workspaceFocused?' <span class="foc">◀ focused</span>':"")+'</div>'+
      '<div class="name"><span class="k">ws</span> '+esc(r.workspaceTitle||"—")+'</div>'+
      '<div class="sid"><span class="k">session</span> '+esc(r.title||"(untitled)")+" · "+r.sessionId.slice(0,8)+" · "+esc(r.workspaceRef||"")+"</div></td>"+
      '<td>'+yn(true)+'</td>'+
      '<td class="v"><span class="pillchip">'+esc(r.authoritativePill??"not swept yet")+'</span></td>'+
      '<td class="v">'+esc(r.derivedLabel??r.trackedLifecycle??"—")+'</td>'+
      '<td>'+(r.pidAlive===null?'<span class="cell-na">idle claim</span>':yn(r.pidAlive))+'</td>'+
      '<td>'+tstate(r.transcriptState)+"</td>";
    live.appendChild(tr);
  }
  if(d.mirror.live.length===0)live.innerHTML='<tr><td colspan="6" style="color:var(--dim)">no bound sessions observed yet</td></tr>';
  const gh=document.getElementById("ghosts");gh.innerHTML="";
  for(const r of d.mirror.ghosts){
    const tr=document.createElement("tr");tr.className="row-bad";
    tr.innerHTML='<td><div class="title">'+esc(r.title||"(untitled)")+'</div><span class="sid">'+r.sessionId.slice(0,8)+'</span></td>'+
      '<td class="v">'+esc(r.trackedLifecycle??"—")+(r.surfaceId?" @ "+r.surfaceId.slice(0,8):"")+'</td>'+
      '<td>'+yn(false)+'</td>'+
      '<td>'+(r.pidAlive===null?'<span class="cell-na">—</span>':yn(r.pidAlive))+'</td>'+
      "<td>"+tstate(r.transcriptState)+"</td>";
    gh.appendChild(tr);
  }
  if(d.mirror.ghosts.length===0)gh.innerHTML='<tr><td colspan="5" style="color:var(--ok)">no ghosts — every tracked session has a real surface</td></tr>';
  const u=d.mirror.unboundSurfaces;
  document.getElementById("unbound").textContent=u.length===0?"none":u.map(x=>x.workspaceRef).join(", ");
}
tick();setInterval(tick,1000);
</script>
</body>
</html>`;

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
startEventKicker();
void sweepLoop();

export { server };
