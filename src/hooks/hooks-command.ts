/**
 * `ccs hooks <explain|lint>` — the observability commands for layered hook resolution (ADR-0045).
 *
 *   ccs hooks explain <session-id|.> <type>   -> which levels contributed + the effective config
 *   ccs hooks lint                            -> flag unknown/misnamed hook files in the config tree
 *
 * These make the determinism guarantee INSPECTABLE: a surprising hook outcome is always
 * explainable after the fact (which levels, which merge, what result), and a typo that would
 * silently un-enroll a level (file-presence = enrollment) surfaces as a lint error.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { openCatalogue, getRow } from "../catalogue/db.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import { ccsRuntimeRoot } from "../inbox/identity-path.ts";
import { ccsConfigRoot } from "../roles/role-files.ts";
import { resolveConfig } from "./resolve-config.ts";
import { liveResolveCtx } from "./compose-claude-md.ts";
import { knownHookTypes } from "./hook-types.ts";
import { classifyFields } from "./meta-fields.ts";
import { readClusterChangelog, validateChangelog } from "../cluster/changelog.ts";
import { knownStartActions } from "./start-actions.ts";
import { knownSpawnActions } from "./spawn-actions.ts";

function resolveSessionId(raw: string | undefined): string | undefined {
  if (!raw || raw === ".") return process.env.CLAUDE_CODE_SESSION_ID;
  return raw;
}

function explain(sessionId: string, type: string): number {
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    const row = getRow(db, sessionId);
    if (!row) {
      console.error(`ccs hooks explain: no catalogue row for session ${sessionId}`);
      return 1;
    }
    const res = resolveConfig(row, type, liveResolveCtx());
    const home = (p: string) => p.replace(process.env.HOME ?? "~", "~");
    console.log(`hook: ${type}   session: ${sessionId.slice(0, 8)}   role: ${row.role ?? "(none)"}   cluster: ${row.cluster ?? "(none)"}`);
    console.log(`\nlevels (broad → specific):`);
    for (const l of res.layers) {
      const mark = l.error ? "✗" : l.config !== null ? "✓" : "·";
      const note = l.error ? `  ERROR: ${l.error}` : l.config !== null ? "  (contributed)" : "  (absent)";
      console.log(`  ${mark} ${l.level.padEnd(10)} ${home(l.dir)}${note}`);
    }
    if (res.degraded) console.log(`\n⚠ degraded — ${res.errors.length} error(s); valid layers still applied`);
    // meta-update is a freshness CONTRACT (ADR-0044): show each declared field's writer, so it's
    // clear the hook doesn't invent values — each field is kept fresh by its own source.
    if (type === "meta-update") {
      const fields = (res.effective as string[] | null) ?? [];
      const { known, unknown } = classifyFields(fields);
      console.log(`\nfreshness contract (${fields.length} field(s) — kept fresh by their writers, not this hook):`);
      for (const m of known) console.log(`  • ${m.field.padEnd(13)} source: ${m.source.padEnd(9)} ${m.note}`);
      for (const u of unknown) console.log(`  ✗ ${u.padEnd(13)} NO KNOWN WRITER — dead contract (add to meta-fields.ts)`);
      return res.degraded || unknown.length > 0 ? 2 : 0;
    }
    console.log(`\neffective config:`);
    console.log(JSON.stringify(res.effective, null, 2));
    return res.degraded ? 2 : 0;
  } finally {
    db.close();
  }
}

/** Walk the config tree for `.ccs-hooks/` dirs and flag any file that isn't a known type slot. */
function lint(): number {
  const roots = [ccsConfigRoot(), ccsRuntimeRoot()];
  const known = new Set(knownHookTypes());
  const knownActions = new Set(knownStartActions());
  const knownSpawnActionSet = new Set(knownSpawnActions());
  const validExts = new Set(["md", "json"]);
  const problems: string[] = [];
  let checked = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || !existsSync(dir)) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (name === ".ccs-hooks") lintHooksDir(full);
        else if (!name.startsWith(".") || name === ".ccs-hooks") walk(full, depth + 1);
        else walk(full, depth + 1); // still descend into dotdirs like .ccs-config internals
      }
    }
  };
  const lintHooksDir = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      checked++;
      const dot = f.lastIndexOf(".");
      const base = dot === -1 ? f : f.slice(0, dot);
      const ext = dot === -1 ? "" : f.slice(dot + 1);
      if (!validExts.has(ext)) { problems.push(`${join(dir, f)}: not a .md/.json hook file`); continue; }
      if (!known.has(base)) { problems.push(`${join(dir, f)}: unknown hook type "${base}" (known: ${[...known].join(", ")})`); continue; }
      // A meta-update file declaring a field with no known writer is a dead contract (ADR-0044).
      if (base === "meta-update" && ext === "json") {
        try {
          const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as { fields?: string[] };
          const { unknown } = classifyFields(parsed.fields ?? []);
          for (const u of unknown) problems.push(`${join(dir, f)}: meta-update field "${u}" has no known writer (dead contract)`);
        } catch { /* parse errors are caught elsewhere (resolveConfig degraded path) */ }
      }
      // A start/spawn file naming an action with no handler would silently no-op (ADR-0044/0075).
      if ((base === "start" || base === "spawn") && ext === "json") {
        const known = base === "start" ? knownActions : knownSpawnActionSet;
        try {
          const parsed = JSON.parse(readFileSync(join(dir, f), "utf8")) as { actions?: Array<{ name?: string }> };
          for (const a of parsed.actions ?? []) {
            if (a.name && !known.has(a.name)) {
              problems.push(`${join(dir, f)}: ${base} action "${a.name}" has no handler (known: ${[...known].join(", ")})`);
            }
          }
        } catch { /* parse errors caught elsewhere */ }
      }
    }
    // collision: same base with two extensions
    const byBase = new Map<string, string[]>();
    for (const f of readdirSync(dir)) {
      const dot = f.lastIndexOf(".");
      if (dot === -1) continue;
      const base = f.slice(0, dot);
      (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(f);
    }
    for (const [base, fs] of byBase) {
      if (fs.length > 1) problems.push(`${dir}: multiple formats for "${base}" (${fs.join(", ")}) — one per slot`);
    }
  };

  for (const r of roots) walk(r, 0);

  // Cluster CHANGELOG version sequences (ADR-0058): a dup/gap/non-positive version would break the
  // catch-up stamp math silently, so surface it here where a misnamed hook file also surfaces.
  const clustersDir = join(ccsConfigRoot(), "clusters");
  if (existsSync(clustersDir)) {
    let clusters: string[] = [];
    try { clusters = readdirSync(clustersDir); } catch { clusters = []; }
    for (const c of clusters) {
      if (!existsSync(join(clustersDir, c, "CHANGELOG.md"))) continue;
      const log = readClusterChangelog(c);
      if (!log) continue;
      checked++;
      for (const p of validateChangelog(log)) problems.push(`clusters/${c}/CHANGELOG.md: ${p}`);
    }
  }

  if (problems.length === 0) {
    console.log(`ccs hooks lint: OK — ${checked} hook file(s), no problems`);
    return 0;
  }
  console.error(`ccs hooks lint: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  return 1;
}

export function hooksCommand(args: string[]): number {
  const sub = args[0];
  switch (sub) {
    case "explain": {
      const sessionId = resolveSessionId(args[1]);
      const type = args[2];
      if (!sessionId || !type) {
        console.error("usage: ccs hooks explain <session-id|.> <type>");
        return 1;
      }
      return explain(sessionId, type);
    }
    case "lint":
      return lint();
    default:
      console.error("usage: ccs hooks <explain|lint>");
      return 1;
  }
}
