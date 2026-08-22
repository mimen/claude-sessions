/**
 * Run every live ground-truth oracle against this machine's real state and emit one report.
 *
 * Read-only: fresh cmux reads, file stats, ps, git rev-parse, readonly SQLite. Nothing is
 * written outside docs/evidence/. This is the phase-1 evidence run for the sidebar state
 * primitives plan; findings feed the discrepancy ledger, they do not gate anything.
 *
 * bun run scripts/sidebar-ground-truth.ts [--json]
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

interface SectionTiming {
  readonly section: string;
  readonly ms: number;
}

async function timed<T>(
  timings: SectionTiming[],
  section: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings.push({ section, ms: Math.round(performance.now() - start) });
  }
}

function indexIdSet(): { ids: Set<string>; error: string | null } {
  const ids = new Set<string>();
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
    return { ids, error: null };
  } catch (error) {
    return { ids, error: error instanceof Error ? error.message : String(error) };
  }
}

function catalogueOrphans(): Finding[] {
  try {
    const db = new Database(CATALOGUE_PATH(), { readonly: true });
    const rows = db
      .query("SELECT session_id FROM catalogue")
      .all() as Array<{ session_id: string }>;
    db.close();
    const scanned = scanStore(CLAUDE_STORE);
    if (!scanned.ok) {
      return [{
        primitive: "catalogue-identity",
        severity: "error",
        detail: `store scan failed: ${scanned.error.message}`,
      }];
    }
    const onDisk = new Set(scanned.value.map((f) => f.sessionId));
    const orphans = rows.filter((r) => !onDisk.has(r.session_id));
    return [
      {
        primitive: "catalogue-identity",
        severity: orphans.length > 0 ? "warn" : "info",
        detail: `${orphans.length}/${rows.length} catalogue rows have no transcript file on disk (destroyed elsewhere, or tracking drift)`,
      },
    ];
  } catch (error) {
    return [{
      primitive: "catalogue-identity",
      severity: "error",
      detail: `catalogue open failed: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }
}

const timings: SectionTiming[] = [];
const findings: Finding[] = [];
const nowMs = Date.now();

const tree = await timed(timings, "surface-tree", auditSurfaceTree);
findings.push(...tree.findings);

const hooks = await timed(timings, "hook-bindings", () => auditHookBindings(tree.facts));
findings.push(...hooks.findings);

findings.push(...(await timed(timings, "agent-activity", () => auditAgentActivity(tree.facts, hooks.facts))));

let indexRows: ReturnType<typeof readIndexReadOnly> = [];
await timed(timings, "transcript-facts-index-read", async () => {
  try {
    indexRows = readIndexReadOnly(DB_PATH(), { limit: 200 });
  } catch (error) {
    findings.push({
      primitive: "transcript-facts",
      severity: "error",
      detail: `index unreadable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});
findings.push(...auditTranscriptRows(indexRows));

findings.push(catalogueOrphans());

await timed(timings, "coverage", async () => {
  const { ids, error } = indexIdSet();
  if (error !== null) {
    findings.push({
      primitive: "coverage",
      severity: "error",
      detail: `index id set unavailable: ${error}`,
    });
    return;
  }
  const scanned = scanStore(CLAUDE_STORE);
  if (!scanned.ok) {
    findings.push({
      primitive: "coverage",
      severity: "error",
      detail: `store scan failed: ${scanned.error.message}`,
    });
    return;
  }
  const recentFiles = new Map<string, { path: string; mtimeMs: number }>();
  for (const f of scanned.value) {
    if (nowMs - f.mtimeMs < RECENT_WINDOW_MS) recentFiles.set(f.sessionId, { path: f.path, mtimeMs: f.mtimeMs });
  }
  findings.push(...auditCoverage({ indexedIds: ids, recentFiles, nowMs }));
});

findings.push(...(await timed(timings, "directory-facts", () => auditDirectories(indexRows))));

const report = {
  generatedAt: new Date().toISOString(),
  store: CLAUDE_STORE,
  surfaces: tree.facts.surfaces.length,
  hookBindings: hooks.facts.bindingsBySurface.size,
  hookSessionsKnown: hooks.facts.sessions.size,
  indexRowsSampled: indexRows.length,
  timings,
  findings,
};

if (!process.argv.includes("--dry-run-to-stdout")) {
  const outDir = join(import.meta.dir, "..", "docs", "evidence", "sidebar-ground-truth");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${report.generatedAt.replaceAll(/[:.]/g, "-")}.json`);
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`report: ${outFile}\n\n`);
}

process.stdout.write(
  `surfaces=${report.surfaces} bindings=${report.hookBindings} hookSessions=${report.hookSessionsKnown} indexSampled=${report.indexRowsSampled}\n`,
);
process.stdout.write("timings:\n");
for (const t of timings) process.stdout.write(`  ${t.section.padEnd(30)} ${String(t.ms).padStart(6)} ms\n`);

const errors = findings.filter((f) => f.severity === "error");
const warns = findings.filter((f) => f.severity === "warn");
process.stdout.write(`\n${errors.length} errors, ${warns.length} warnings:\n`);
for (const f of [...errors, ...warns]) {
  process.stdout.write(`  [${f.severity}] ${f.primitive}: ${f.detail}\n`);
}
