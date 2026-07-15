import type { Database } from "bun:sqlite";
import type { CatalogueRow } from "./db.ts";
import { getAll, identityKeyOf } from "./db.ts";

/**
 * Identity lineage (ADR-0038): a durable identity may have had SEVERAL session embodiments over
 * time. A fresh embodiment rehydrates from its predecessors — reviewing what past bodies did/
 * tried/concluded — instead of rediscovering it. This resolves an identity to its ordered prior
 * embodiments + each one's transcript path.
 *
 * ADR-0089 (2026-07-14): the identity key is stored as `catalogue.identity_key` — a real FK
 * into the identities table. Callers here read it via `identityKeyOf(row)` from db.ts (which
 * prefers the new structured key). The legacy `deriveKey` fallback is gone — a row without an
 * identity_key is a loose session that has no lineage anyway.
 */

/** The identity key a row belongs to (thin re-export so lineage callers keep a stable name). */
export function identityKey(row: CatalogueRow): string | null {
  return identityKeyOf(row);
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
