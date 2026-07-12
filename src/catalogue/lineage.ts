import type { Database } from "bun:sqlite";
import type { CatalogueRow } from "./db.ts";
import { getAll } from "./db.ts";
import { rowWorkUnit } from "./spawn-contract.ts";

/**
 * Identity lineage (ADR-0038): a durable identity (responsibility) may have had SEVERAL session
 * embodiments over time. A fresh embodiment rehydrates from its predecessors — reviewing what
 * past bodies did/tried/concluded — instead of rediscovering it. This resolves an identity to
 * its ordered prior embodiments + each one's transcript path.
 *
 * The identity KEY is the responsibility (ADR-0026/0030): a fleet worker's work-unit
 * (pr:repo#num / gus:W-…), or a core role's role name. Grouping on that key is what makes the
 * lineage findable without a stored predecessor pointer — session id is disposable, the
 * responsibility is durable.
 */

/** The responsibility key a row belongs to (work-unit for fleet, role for core). Null = unkeyed.
 * ADR-0057: prefer the STABLE work-unit id (the entity's identity) when the row carries one; fall
 * back to the derived pr:/gus: string for older rows not yet backfilled, then to the role for a
 * core singleton. Keying on the id means two sessions of the same work-unit group even if their
 * derived strings drifted, and a work-unit whose PR was attached later still matches its lineage. */
export function identityKey(row: CatalogueRow): string | null {
  if (row.workUnitId) return `wu:${row.workUnitId}`;
  const unit = rowWorkUnit(row); // pr:repo#num | gus:W-… | null (legacy, pre-backfill)
  if (unit) return unit;
  if (row.role) return `role:${row.role}`;
  return null;
}

export interface Embodiment {
  sessionId: string;
  /** Absolute path to the session's transcript (.jsonl), or null if not indexed. */
  transcriptPath: string | null;
  /** Last-activity timestamp for ordering (ISO), or null. */
  lastTs: string | null;
  completed: boolean;
  archived: boolean;
}

/**
 * The predecessors of `sessionId` within its identity: every OTHER session sharing its
 * responsibility key, oldest → newest. `sessionId` itself is excluded (it's the current
 * embodiment). Returns [] if the row isn't keyed or has no siblings.
 *
 * `transcriptPaths` maps session_id → indexed transcript path (the caller reads it from the
 * index; passed in so this stays a pure join over already-gathered facts, testable without I/O).
 */
export function predecessorsOf(
  rows: ReadonlyMap<string, CatalogueRow>,
  sessionId: string,
  transcriptPaths: ReadonlyMap<string, { path: string | null; lastTs: string | null }>,
): Embodiment[] {
  const self = rows.get(sessionId);
  if (!self) return [];
  const key = identityKey(self);
  if (!key) return [];

  const sibs: Embodiment[] = [];
  for (const [sid, row] of rows) {
    if (sid === sessionId) continue; // exclude self
    if (identityKey(row) !== key) continue;
    const t = transcriptPaths.get(sid) ?? { path: null, lastTs: null };
    sibs.push({
      sessionId: sid,
      transcriptPath: t.path,
      lastTs: t.lastTs,
      completed: row.completed,
      archived: row.archived,
    });
  }
  // oldest → newest by lastTs (nulls last), so the fresh embodiment reads history in order.
  // sessionId is the stable final tie-break: equal (or both-null) lastTs must not depend on the
  // JS engine's unstable-sort behavior, or lineage order flips between runtimes (ADR determinism).
  sibs.sort((a, b) => {
    if (a.lastTs && b.lastTs) {
      if (a.lastTs !== b.lastTs) return a.lastTs < b.lastTs ? -1 : 1;
      return a.sessionId.localeCompare(b.sessionId);
    }
    if (a.lastTs) return -1;
    if (b.lastTs) return 1;
    return a.sessionId.localeCompare(b.sessionId);
  });
  return sibs;
}

/** DB-backed resolver: gather the catalogue rows + index transcript paths, run the pure join. */
export function resolvePredecessors(catalogue: Database, index: Database, sessionId: string): Embodiment[] {
  const rows = getAll(catalogue);
  const paths = new Map<string, { path: string | null; lastTs: string | null }>();
  try {
    const q = index.query("SELECT session_id, path, last_ts FROM sessions");
    for (const r of q.all() as Array<{ session_id: string; path: string | null; last_ts: string | null }>) {
      paths.set(r.session_id, { path: r.path, lastTs: r.last_ts });
    }
  } catch {
    /* index unreadable → transcripts unknown; predecessors still list by id (fail-open) */
  }
  return predecessorsOf(rows, sessionId, paths);
}
