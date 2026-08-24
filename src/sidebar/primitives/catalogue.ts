/**
 * Primitive 5 — the catalogue: durable CCS-authored session facts.
 *
 * Answers: lifecycle per session (idle/parked/saved/completed/archived), incognito and
 * auxiliary marks, T3 association, canonical ids, preferred titles, enrichment summaries.
 * CCS itself owns the writes; this primitive is read-only.
 *
 * Change signal: `PRAGMA data_version` on a persistent readonly connection — a header-level
 * probe that advances on any committed write, including ones from other processes. The full
 * facts re-read only when the probe moves, so polling is microseconds, not queries.
 *
 * Failure posture: degraded-retained. An unreadable probe or re-read keeps the last complete
 * facts with the revision frozen; a first read that fails yields empty facts and `readable:
 * false` rather than invented activity.
 */
import { Database } from "bun:sqlite";
import { readCatalogueReadOnly, type CatalogueSnapshotFacts } from "../catalogue-read.ts";

export interface CatalogueRead {
  readonly facts: CatalogueSnapshotFacts;
  readonly readable: boolean;
  readonly revision: number;
}

export interface CatalogueReaderIo {
  readonly dbPath: string;
  /** Re-read the full facts through the established query-only adapter. */
  readFacts(): CatalogueSnapshotFacts | null;
}

export interface CatalogueReader {
  read(): Promise<CatalogueRead>;
  close(): void;
}

export function createCatalogueReader(io: CatalogueReaderIo): CatalogueReader {
  let db: Database | null = null;
  let lastVersion: number | null = null;
  let revision = 0;
  let facts: CatalogueSnapshotFacts | null = null;

  function connection(): Database | null {
    if (db) return db;
    try {
      db = new Database(io.dbPath, { readonly: true });
      db.exec("PRAGMA query_only = ON;");
      return db;
    } catch {
      db = null;
      return null;
    }
  }

  return {
    async read(): Promise<CatalogueRead> {
      const conn = connection();
      if (conn === null) {
        return {
          facts: facts ?? emptyFacts(),
          readable: false,
          revision,
        };
      }
      let version: number;
      try {
        version = (conn.query("PRAGMA data_version").get() as { data_version: number }).data_version;
      } catch {
        return { facts: facts ?? emptyFacts(), readable: false, revision };
      }
      if (version === lastVersion && facts !== null) {
        return { facts, readable: true, revision };
      }
      const fresh = io.readFacts();
      if (fresh === null) {
        // The adapter could not read; keep whatever we had rather than degrading to empty.
        return { facts: facts ?? emptyFacts(), readable: facts !== null, revision };
      }
      facts = fresh;
      const changed = lastVersion !== null && version !== lastVersion;
      lastVersion = version;
      if (changed || revision === 0) revision += 1;
      return { facts, readable: true, revision };
    },
    close() {
      db?.close();
      db = null;
    },
  };
}

function emptyFacts(): CatalogueSnapshotFacts {
  // Shape-complete empty facts: a first read that failed is "nothing known", not "all active".
  return {
    lifecycles: new Map(),
    catalogueLifecycles: new Map(),
    canonicalSessionIds: new Map(),
    preferredTitles: new Map(),
    memberships: new Map(),
    sessionIds: new Map([
      ["active", []],
      ["completed", []],
      ["saved", []],
    ]),
    auxiliary: new Set(),
    incognito: new Set(),
    t3Associated: new Set(),
    summaries: new Map(),
  };
}

/** Production IO: the established query-only adapter over the given catalogue path. */
export function productionCatalogueFactsReader(dbPath: string): () => CatalogueSnapshotFacts | null {
  return () => {
    const outcome = readCatalogueReadOnly(dbPath);
    return outcome.status === "ok" ? outcome.facts : null;
  };
}
