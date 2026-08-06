import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  readCatalogueDatabase,
  type CatalogueReadOutcome,
} from "./catalogue-read.ts";
import {
  readIndexDatabase,
  type ReadIndexOptions,
} from "./index-read.ts";
import type { IndexedSessionInput } from "./projection.ts";

interface DurableReader<T> {
  read(key: string, load: (db: Database) => T): T;
  revision(): number;
  close(): void;
}

function dataVersion(db: Database): number {
  const row = db.query("PRAGMA data_version").get() as { readonly data_version: number };
  return row.data_version;
}

/**
 * One long-lived query-only SQLite connection and the durable facts derived from its current commit.
 * `data_version` changes only for commits made by another connection, exactly the writer pattern the
 * sidebar must observe. A changed version clears all derived facts once, on the next read.
 */
function durableReader<T>(path: string): DurableReader<T> {
  let db: Database | null = null;
  let observedVersion: number | null = null;
  let revisionNumber = 0;
  const values = new Map<string, T>();

  function connection(): Database {
    if (db !== null) return db;
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA query_only = ON;");
    observedVersion = dataVersion(db);
    revisionNumber += 1;
    return db;
  }

  function observe(current: Database): void {
    const next = dataVersion(current);
    if (observedVersion === next) return;
    observedVersion = next;
    revisionNumber += 1;
    values.clear();
  }

  return {
    read(key: string, load: (database: Database) => T): T {
      const current = connection();
      observe(current);
      const cached = values.get(key);
      if (cached !== undefined) return cached;
      const value = load(current);
      values.set(key, value);
      return value;
    },
    revision: () => revisionNumber,
    close(): void {
      db?.close();
      db = null;
      observedVersion = null;
      values.clear();
    },
  };
}

export interface SidebarDurableRevision {
  readonly catalogue: number;
  readonly index: number;
}

export interface SidebarReadCache {
  readCatalogue(): CatalogueReadOutcome;
  readIndex(options: ReadIndexOptions): readonly IndexedSessionInput[];
  revision(): SidebarDurableRevision;
  invalidate(): void;
  close(): void;
}

function indexKey(options: ReadIndexOptions): string {
  return JSON.stringify({
    limit: options.limit,
    sessionIds: options.sessionIds === undefined ? null : [...new Set(options.sessionIds)].sort(),
  });
}

/** Cache durable sidebar facts while retaining exact cross-connection invalidation. */
export function createSidebarReadCache(
  cataloguePath: string,
  indexPath: string,
): SidebarReadCache {
  let catalogue = durableReader<CatalogueReadOutcome>(cataloguePath);
  let index = durableReader<readonly IndexedSessionInput[]>(indexPath);

  return {
    readCatalogue(): CatalogueReadOutcome {
      if (!existsSync(cataloguePath)) {
        catalogue.close();
        return { status: "missing" };
      }
      try {
        return catalogue.read("catalogue", readCatalogueDatabase);
      } catch (error) {
        return {
          status: "unreadable",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
    readIndex(options: ReadIndexOptions): readonly IndexedSessionInput[] {
      if (!existsSync(indexPath)) {
        index.close();
        throw new Error("session index is missing");
      }
      return index.read(indexKey(options), (db) => readIndexDatabase(db, options));
    },
    revision(): SidebarDurableRevision {
      return { catalogue: catalogue.revision(), index: index.revision() };
    },
    invalidate(): void {
      catalogue.close();
      index.close();
      catalogue = durableReader<CatalogueReadOutcome>(cataloguePath);
      index = durableReader<readonly IndexedSessionInput[]>(indexPath);
    },
    close(): void {
      catalogue.close();
      index.close();
    },
  };
}
