/**
 * `ccs catalogue export --cluster <name> [--role <role>] [--json]` — machine-readable catalogue
 * projection for CLUSTER ENGINES to consume instead of reading the private SQLite directly.
 *
 * D1 (2026-07-14): before this command, cluster Python (`compose_board.py`, `worker_activity.py`)
 * opened `~/.ccs/cache/catalogue.db` via sqlite3 and re-implemented row parsing + identity key
 * derivation. That made the DB schema the de-facto tool↔cluster contract — every schema bump was
 * secretly a two-repo, two-language migration, and identity key derivation drifted (bug B3 in
 * the 2026-07-14 full-system review). This command is the ONE authorized read path; the schema
 * is versioned and stable across catalogue migrations.
 *
 * Output shape (schema v2):
 * {
 *   schema: 1,                       // bump on breaking changes
 *   generatedAt: "…",                // ISO
 *   cluster: "pr-watch" | null,      // filter applied (null = --all-clusters)
 *   role: "pr-agent" | null,         // filter applied (null = all roles)
 *   category: "ai-systems" | null,    // effective-category filter (null = all)
 *   count: <n>,
 *   rows: [
 *     {
 *       sessionId, key, role, cluster, workUnitId, groupingId, gusWork,
 *       prRepo, prNumber, prBranch, prState, prHeadSha,
 *       stage, statusLine, meta,               // meta is the JSON-decoded map
 *       customTitle, kind, resumeCommand,
 *       completed, archived, parkedTaskId, parentSessionId,
 *       project, notes, updatedAt,
 *       storedCategory, effectiveCategory, categoryFinding,
 *     },
 *   ],
 * }
 */
import type { Database } from "bun:sqlite";
import { openCatalogue, type CatalogueRow } from "./db-schema.ts";
import { getAll } from "./db-queries.ts";
import { isIncognito } from "./incognito.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import { getAllCategoryAssignments, resolveEffectiveCategory, type EffectiveCategory } from "../categories/assignment.ts";

export const EXPORT_SCHEMA_VERSION = 2;

export interface CatalogueExportRow {
  sessionId: string;
  /** ADR-0089 primary identity key. `key` is a legacy alias returning the same value. */
  identityKey: string | null;
  key: string | null;
  role: string | null;
  cluster: string | null;
  workUnitId: string | null;
  groupingId: string | null;
  gusWork: string | null;
  prRepo: string | null;
  prNumber: number | null;
  prBranch: string | null;
  prState: string | null;
  prHeadSha: string | null;
  stage: string | null;
  statusLine: string | null;
  meta: Record<string, unknown>;
  customTitle: string | null;
  kind: string;
  resumeCommand: string | null;
  completed: boolean;
  archived: boolean;
  parkedTaskId: string | null;
  parentSessionId: string | null;
  project: string | null;
  notes: string | null;
  updatedAt: string | null;
  storedCategory: string | null;
  effectiveCategory: string | null;
  categoryFinding: EffectiveCategory["finding"];
}

export interface CatalogueExport {
  schema: number;
  generatedAt: string;
  cluster: string | null;
  role: string | null;
  category: string | null;
  count: number;
  rows: CatalogueExportRow[];
}

function toExportRow(r: CatalogueRow, category: EffectiveCategory): CatalogueExportRow {
  return {
    sessionId: r.sessionId,
    identityKey: r.identityKey,
    key: r.key,
    role: r.role,
    cluster: r.cluster,
    workUnitId: r.workUnitId,
    groupingId: r.groupingId,
    gusWork: r.gusWork,
    prRepo: r.prRepo,
    prNumber: r.prNumber,
    prBranch: r.prBranch,
    prState: r.prState,
    prHeadSha: r.prHeadSha,
    stage: r.stage,
    statusLine: r.statusLine,
    meta: r.meta,
    customTitle: r.customTitle,
    kind: r.kind,
    resumeCommand: r.resumeCommand,
    completed: r.completed,
    archived: r.archived,
    parkedTaskId: r.parkedTaskId,
    parentSessionId: r.parentSessionId,
    project: r.project,
    notes: r.notes,
    updatedAt: r.updatedAt,
    storedCategory: category.storedSlug,
    effectiveCategory: category.slug,
    categoryFinding: category.finding,
  };
}

/** Pure: filter+project catalogue rows into the export shape. Exported for tests. */
export function buildExport(
  rows: Iterable<CatalogueRow>,
  filter: { cluster?: string | null; role?: string | null; category?: string | null },
  now: string,
  categories: ReadonlyMap<string, EffectiveCategory> = new Map(),
): CatalogueExport {
  const out: CatalogueExportRow[] = [];
  for (const r of rows) {
    // Unfiltered, this is the documented read path cluster engines consume, so an incognito
    // session would leave ccs entirely through it.
    if (isIncognito(r)) continue;
    if (filter.cluster && r.cluster !== filter.cluster) continue;
    if (filter.role && r.role !== filter.role) continue;
    const category = categories.get(r.sessionId) ?? {
      slug: null, storedSlug: null, inheritedFrom: null, finding: "uncategorized" as const,
    };
    if (filter.category && category.slug !== filter.category) continue;
    out.push(toExportRow(r, category));
  }
  return {
    schema: EXPORT_SCHEMA_VERSION,
    generatedAt: now,
    cluster: filter.cluster ?? null,
    role: filter.role ?? null,
    category: filter.category ?? null,
    count: out.length,
    rows: out,
  };
}

/** DB-backed entry: read all catalogue rows, filter, emit. */
export function catalogueExport(
  db: Database,
  filter: { cluster?: string | null; role?: string | null; category?: string | null },
): CatalogueExport {
  const rows = getAll(db);
  const assignments = getAllCategoryAssignments(db);
  const parents = new Map<string, string>();
  for (const row of rows.values()) if (row.parentSessionId) parents.set(row.sessionId, row.parentSessionId);
  const known = new Set(rows.keys());
  const classes = new Map([...rows].map(([id, row]) => [id, row.sessionClass]));
  const categories = new Map<string, EffectiveCategory>();
  for (const id of known) categories.set(id, resolveEffectiveCategory(id, assignments, parents, known, classes));
  return buildExport(rows.values(), filter, new Date().toISOString(), categories);
}

export function catalogueExportCommand(args: string[]): number {
  const sub = args[0];
  if (sub !== "export") {
    console.error("usage: ccs catalogue export --cluster <name> [--role <r>] [--category <slug>] [--json]");
    return 1;
  }
  const rest = args.slice(1);
  const idx = (flag: string) => rest.indexOf(flag);
  const clusterI = idx("--cluster");
  const roleI = idx("--role");
  const categoryI = idx("--category");
  const cluster = clusterI >= 0 ? rest[clusterI + 1] : null;
  const role = roleI >= 0 ? rest[roleI + 1] : null;
  const category = categoryI >= 0 ? rest[categoryI + 1] : null;
  if (clusterI >= 0 && !cluster) {
    console.error("--cluster requires a name");
    return 1;
  }
  if (roleI >= 0 && !role) {
    console.error("--role requires a name");
    return 1;
  }
  if (categoryI >= 0 && !category) {
    console.error("--category requires a slug");
    return 1;
  }

  // A fresh CCS_ROOT has no ~/.ccs/cache dir yet; opening the DB without this
  // would crash with SQLITE_CANTOPEN instead of returning {rows: []}.
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  const result = catalogueExport(db, { cluster, role, category });
  // --json is the default when piped; keep it explicit for future --text
  console.log(JSON.stringify(result));
  return 0;
}
