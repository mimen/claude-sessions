import { existsSync, statSync } from "node:fs";
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

interface FileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

function fileIdentity(path: string): FileIdentity {
  const stats = statSync(path, { bigint: true });
  return { device: stats.dev, inode: stats.ino };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function dataVersion(db: Database): number {
  const row = db.query("PRAGMA data_version").get() as { readonly data_version: number };
  return row.data_version;
}

/**
 * One long-lived query-only SQLite connection and the durable facts derived from its current commit.
 * `data_version` efficiently detects commits to the opened file, while device/inode identity detects
 * an atomic rename that replaced the path with a different database. Either change clears all
 * derived facts once, on the next read.
 */
function durableReader<T>(path: string): DurableReader<T> {
  let db: Database | null = null;
  let openedIdentity: FileIdentity | null = null;
  let observedVersion: number | null = null;
  let revisionNumber = 0;
  const values = new Map<string, T>();

  function closeConnection(): void {
    db?.close();
    db = null;
    openedIdentity = null;
    observedVersion = null;
    values.clear();
  }

  function openConnection(): Database {
    while (true) {
      const beforeOpen = fileIdentity(path);
      const candidate = new Database(path, { readonly: true });
      try {
        candidate.exec("PRAGMA query_only = ON;");
        const version = dataVersion(candidate);
        const afterOpen = fileIdentity(path);
        if (!sameFile(beforeOpen, afterOpen)) {
          candidate.close();
          continue;
        }
        db = candidate;
        openedIdentity = afterOpen;
        observedVersion = version;
        revisionNumber += 1;
        return candidate;
      } catch (error) {
        candidate.close();
        throw error;
      }
    }
  }

  function observe(): Database {
    while (true) {
      const current = db ?? openConnection();
      const identity = openedIdentity;
      if (identity === null) continue;
      try {
        const beforeVersion = fileIdentity(path);
        if (!sameFile(identity, beforeVersion)) {
          closeConnection();
          continue;
        }
        const next = dataVersion(current);
        const afterVersion = fileIdentity(path);
        if (!sameFile(identity, afterVersion)) {
          closeConnection();
          continue;
        }
        if (observedVersion !== next) {
          observedVersion = next;
          revisionNumber += 1;
          values.clear();
        }
        return current;
      } catch (error) {
        closeConnection();
        throw error;
      }
    }
  }

  return {
    read(key: string, load: (database: Database) => T): T {
      const current = observe();
      const cached = values.get(key);
      if (cached !== undefined) return cached;
      const value = load(current);
      values.set(key, value);
      return value;
    },
    revision: () => revisionNumber,
    close: closeConnection,
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
