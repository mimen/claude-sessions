import { Buffer } from "node:buffer";
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
  /** Observe only file identity and SQLite commit metadata. */
  reconcile(): boolean;
  revision(): number;
  close(): void;
}

interface DurableReaderCacheOptions<T> {
  readonly maxEntries: number;
  readonly maxBytes: number;
  retainedBytes(value: T): number;
}

interface CachedValue<T> {
  readonly value: T;
  readonly retainedBytes: number;
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
const MAX_OBSERVE_ATTEMPTS = 3;

function durableReader<T>(
  path: string,
  cacheOptions: DurableReaderCacheOptions<T>,
): DurableReader<T> {
  let db: Database | null = null;
  let openedIdentity: FileIdentity | null = null;
  let observedVersion: number | null = null;
  let revisionNumber = 0;
  let retainedBytes = 0;
  const values = new Map<string, CachedValue<T>>();

  function clearValues(): void {
    values.clear();
    retainedBytes = 0;
  }

  function removeValue(key: string): void {
    const entry = values.get(key);
    if (entry === undefined) return;
    retainedBytes -= entry.retainedBytes;
    values.delete(key);
  }

  function closeConnection(): void {
    db?.close();
    db = null;
    openedIdentity = null;
    observedVersion = null;
    clearValues();
  }

  function openConnection(): Database {
    for (let attempt = 0; attempt < MAX_OBSERVE_ATTEMPTS; attempt += 1) {
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
    throw new Error(`sidebar database kept changing while opening: ${path}`);
  }

  function observe(): Database {
    for (let attempt = 0; attempt < MAX_OBSERVE_ATTEMPTS; attempt += 1) {
      const current = db ?? openConnection();
      const identity = openedIdentity;
      if (identity === null) throw new Error(`sidebar database opened without an identity: ${path}`);
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
          clearValues();
        }
        return current;
      } catch (error) {
        closeConnection();
        throw error;
      }
    }
    throw new Error(`sidebar database kept changing while observing: ${path}`);
  }

  return {
    read(key: string, load: (database: Database) => T): T {
      const current = observe();
      const cached = values.get(key);
      if (cached !== undefined) {
        values.delete(key);
        values.set(key, cached);
        return cached.value;
      }

      const value = load(current);
      const valueBytes = Buffer.byteLength(key) + cacheOptions.retainedBytes(value);
      if (
        cacheOptions.maxEntries === 0
        || valueBytes > cacheOptions.maxBytes
      ) {
        return value;
      }

      while (
        values.size >= cacheOptions.maxEntries
        || retainedBytes + valueBytes > cacheOptions.maxBytes
      ) {
        const oldest = values.keys().next().value;
        if (oldest === undefined) break;
        removeValue(oldest);
      }
      values.set(key, { value, retainedBytes: valueBytes });
      retainedBytes += valueBytes;
      return value;
    },
    reconcile(): boolean {
      const before = revisionNumber;
      observe();
      return revisionNumber !== before;
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
  /** Observe file identity and SQLite commit headers without loading derived facts. */
  reconcile(): boolean;
  revision(): SidebarDurableRevision;
  invalidate(): void;
  close(): void;
}

export interface SidebarReadCacheOptions {
  /** Test seam; production matches the serialized response cache's entry bound. */
  readonly maxEntries?: number;
  /** Test seam; production matches the serialized response cache's four MiB bound. */
  readonly maxBytes?: number;
  /** Called once when a durable source enters a new unreadable state. */
  readonly onReconcileError?: (source: "catalogue" | "index", error: Error) => void;
}

const MAX_DERIVED_VALUES = 16;
const MAX_DERIVED_VALUE_BYTES = 4 * 1024 * 1024;

function boundedLimit(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.floor(value));
}

function serializedBytes(value: object): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function catalogueRetainedBytes(outcome: CatalogueReadOutcome): number {
  if (outcome.status !== "ok") {
    return serializedBytes(
      outcome.status === "unreadable"
        ? { status: outcome.status, error: outcome.error.message }
        : outcome,
    );
  }
  const facts = outcome.facts;
  return serializedBytes({
    lifecycles: [...facts.lifecycles],
    catalogueLifecycles: [...facts.catalogueLifecycles],
    canonicalSessionIds: [...facts.canonicalSessionIds],
    preferredTitles: [...facts.preferredTitles],
    memberships: [...facts.memberships],
    sessionIds: [...facts.sessionIds],
    auxiliary: [...facts.auxiliary],
    t3Associated: [...facts.t3Associated],
    t3SessionIds: facts.t3SessionIds,
    summaries: [...facts.summaries],
  });
}

function indexRetainedBytes(value: readonly IndexedSessionInput[]): number {
  return serializedBytes(value);
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
  options: SidebarReadCacheOptions = {},
): SidebarReadCache {
  const maxEntries = boundedLimit(options.maxEntries, MAX_DERIVED_VALUES);
  const maxBytes = boundedLimit(options.maxBytes, MAX_DERIVED_VALUE_BYTES);
  const catalogueOptions: DurableReaderCacheOptions<CatalogueReadOutcome> = {
    maxEntries,
    maxBytes,
    retainedBytes: catalogueRetainedBytes,
  };
  const indexOptions: DurableReaderCacheOptions<readonly IndexedSessionInput[]> = {
    maxEntries,
    maxBytes,
    retainedBytes: indexRetainedBytes,
  };
  let catalogue = durableReader(cataloguePath, catalogueOptions);
  let index = durableReader(indexPath, indexOptions);
  interface ReconcileState {
    initialized: boolean;
    exists: boolean;
    readable: boolean;
    error: string | null;
  }
  const catalogueState: ReconcileState = {
    initialized: false,
    exists: false,
    readable: false,
    error: null,
  };
  const indexState: ReconcileState = {
    initialized: false,
    exists: false,
    readable: false,
    error: null,
  };

  function reconcileReader<T>(
    source: "catalogue" | "index",
    path: string,
    reader: DurableReader<T>,
    state: ReconcileState,
  ): boolean {
    const present = existsSync(path);
    const observedBefore = reader.revision() > 0;
    let readable = false;
    let commitChanged = false;
    let nextError: Error | null = null;
    if (present) {
      try {
        commitChanged = reader.reconcile();
        readable = true;
      } catch (error) {
        reader.close();
        nextError = error instanceof Error ? error : new Error(String(error));
      }
    } else {
      reader.close();
    }
    if (nextError !== null && state.error !== nextError.message) {
      options.onReconcileError?.(source, nextError);
    }

    if (!state.initialized) {
      state.initialized = true;
      state.exists = present;
      state.readable = readable;
      state.error = nextError?.message ?? null;
      return observedBefore && commitChanged;
    }

    const changed = commitChanged || state.exists !== present || state.readable !== readable;
    state.exists = present;
    state.readable = readable;
    state.error = nextError?.message ?? null;
    return changed;
  }

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
    reconcile(): boolean {
      const catalogueChanged = reconcileReader(
        "catalogue",
        cataloguePath,
        catalogue,
        catalogueState,
      );
      const indexChanged = reconcileReader("index", indexPath, index, indexState);
      return catalogueChanged || indexChanged;
    },
    revision(): SidebarDurableRevision {
      return { catalogue: catalogue.revision(), index: index.revision() };
    },
    invalidate(): void {
      catalogue.close();
      index.close();
      catalogue = durableReader(cataloguePath, catalogueOptions);
      index = durableReader(indexPath, indexOptions);
    },
    close(): void {
      catalogue.close();
      index.close();
    },
  };
}
