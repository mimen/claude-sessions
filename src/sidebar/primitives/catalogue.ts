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
import { statSync } from "node:fs";
import { readCatalogueReadOnly, type CatalogueSnapshotFacts } from "../catalogue-read.ts";

export interface CatalogueRead {
  readonly facts: CatalogueSnapshotFacts;
  readonly readable: boolean;
  readonly revision: number;
}

export interface CatalogueReaderIo {
  /**
   * Owned probe: probe this file's inode identity + data_version. Used when no external
   * probe is supplied. Omit when the consumer has a change detector that already covers
   * every file its readFacts adapter touches.
   */
  readonly dbPath?: string;
  /**
   * External change detector: return true when the sources behind readFacts may have
   * changed. Runs every read; a false means the cached facts are still trustworthy.
   */
  readonly probe?: () => boolean;
  /** Re-read the full facts through the established query-only adapter. */
  readFacts(): CatalogueSnapshotFacts | null;
  /**
   * Failure posture on a failed re-read:
   *   - "retain" (default): keep the last complete facts — a stale fact beats a blank one.
   *   - "empty": degrade to empty facts — the consumer's contract is "unknown ⇒ treat as
   *     active" so nothing is ever hidden by a broken catalogue. The snapshot's posture.
   */
  readonly degradeTo?: "retain" | "empty";
}

export interface CatalogueReader {
  read(): CatalogueRead;
  close(): void;
}

export function createCatalogueReader(io: CatalogueReaderIo): CatalogueReader {
  let db: Database | null = null;
  let lastVersion: number | null = null;
  let revision = 0;
  let facts: CatalogueSnapshotFacts | null = null;
  /**
   * Device/inode identity of the file the connection was opened against. Reindex and the
   * catalogue refresh replace the file atomically (temp + rename), so a commit can arrive as a
   * NEW inode while this connection keeps reading the old one — data_version would never move.
   * An identity change forces a reconnect and a full re-read regardless of the version number.
   */
  let lastFileIdentity: { dev: number; ino: number } | null = null;

  function fileIdentity(): { dev: number; ino: number } | null {
    if (!io.dbPath) return null;
    try {
      const st = statSync(io.dbPath);
      return { dev: st.dev, ino: st.ino };
    } catch {
      return null;
    }
  }

  function connection(): Database | null {
    if (!io.dbPath) return null;
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
    read(): CatalogueRead {
      // External probe wins when supplied: the consumer knows which files its adapter reads.
      if (io.probe) {
        if (!io.probe() && facts !== null) {
          return { facts, readable: true, revision };
        }
        const fresh = io.readFacts();
        if (fresh === null) {
          if (io.degradeTo === "empty") {
            facts = emptyFacts();
            return { facts, readable: false, revision };
          }
          return { facts: facts ?? emptyFacts(), readable: facts !== null, revision };
        }
        facts = fresh;
        revision += 1;
        return { facts, readable: true, revision };
      }

      // Owned probe: inode identity + data_version on io.dbPath.
      const identity = fileIdentity();
      const replaced =
        identity !== null && lastFileIdentity !== null
        && (identity.dev !== lastFileIdentity.dev || identity.ino !== lastFileIdentity.ino);
      if (replaced) {
        // The file was swapped under us (temp + rename); this handle reads a dead inode.
        try {
          db?.close();
        } catch {
          // already closed
        }
        db = null;
      }
      if (identity !== null) lastFileIdentity = identity;
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
      if (!replaced && version === lastVersion && facts !== null) {
        return { facts, readable: true, revision };
      }
      const fresh = io.readFacts();
      if (fresh === null) {
        if (io.degradeTo === "empty") {
          facts = emptyFacts();
          return { facts, readable: false, revision };
        }
        // The adapter could not read; keep whatever we had rather than degrading to empty.
        return { facts: facts ?? emptyFacts(), readable: facts !== null, revision };
      }
      facts = fresh;
      const changed = replaced || (lastVersion !== null && version !== lastVersion) || revision === 0;
      lastVersion = version;
      if (changed) revision += 1;
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
    t3SessionIds: [],
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
