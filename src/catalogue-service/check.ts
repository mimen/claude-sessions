import { Database } from "bun:sqlite";
import { loadConfig } from "../config.ts";
import { canonicalStoreFiles } from "../index/index.ts";
import { CONFIG_PATH, CATALOGUE_SERVICE_LOCK_PATH, DB_PATH } from "../paths.ts";
import { type Result, err, ok } from "../result.ts";
import { scanStore } from "../store.ts";
import { inspectCatalogueServiceProcess } from "./server.ts";

export const CATALOGUE_SOURCE_STALE_AFTER_MS = 2 * 60 * 60 * 1_000;

export interface CatalogueServiceState {
  readonly running: boolean;
  readonly pid: number | null;
}

interface SourceIndexFields {
  readonly sourceLatestMtimeMs: number | null;
  readonly indexedLatestMtimeMs: number | null;
  readonly lagMs: number | null;
  readonly staleAfterMs: number;
  readonly sourceFiles: number;
  readonly indexedSessions: number;
  readonly outOfSyncSessions: number;
  readonly generation: number | null;
  readonly indexedAt: string | null;
  readonly refreshedAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastError: string | null;
}

export type CatalogueSourceIndexState =
  | ({ readonly state: "fresh" } & SourceIndexFields)
  | ({ readonly state: "stale" } & SourceIndexFields)
  | ({ readonly state: "unavailable" } & SourceIndexFields);

export interface CatalogueCheckReport {
  readonly healthy: boolean;
  readonly service: CatalogueServiceState;
  readonly sourceIndex: CatalogueSourceIndexState;
}

interface SourceSignature {
  readonly path: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

interface SourceObservation {
  readonly latestMtimeMs: number | null;
  readonly files: number;
  readonly sessions: ReadonlyMap<string, SourceSignature>;
}

interface IndexSignature {
  readonly path: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

interface IndexObservation {
  readonly latestMtimeMs: number | null;
  readonly sessions: ReadonlyMap<string, IndexSignature>;
  readonly generation: number;
  readonly indexedAt: string | null;
  readonly refreshedAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastError: string | null;
}

interface RawIndexSession {
  readonly sessionId: string;
  readonly path: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

interface RawSourceStatus {
  readonly generation: number;
  readonly indexedAt: string | null;
  readonly refreshedAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastError: string | null;
}

export interface CatalogueCheckOptions {
  readonly configPath?: string;
  readonly indexPath?: string;
  readonly lockPath?: string;
  readonly staleAfterMs?: number;
  readonly nowMs?: number;
  readonly inspectService?: (lockPath: string) => CatalogueServiceState;
}

function observeSource(configPath: string): Result<SourceObservation> {
  const configured = loadConfig(configPath);
  if (!configured.ok) return err(configured.error);
  const scanned = scanStore(configured.value.store.path);
  if (!scanned.ok) return err(scanned.error);

  let latestMtimeMs: number | null = null;
  const sessions = new Map<string, SourceSignature>();
  for (const candidate of canonicalStoreFiles(scanned.value)) {
    sessions.set(candidate.sessionId, {
      path: candidate.file.path,
      mtimeMs: candidate.file.mtimeMs,
      sizeBytes: candidate.file.sizeBytes,
    });
    if (latestMtimeMs === null || candidate.file.mtimeMs > latestMtimeMs) {
      latestMtimeMs = candidate.file.mtimeMs;
    }
  }
  return ok({ latestMtimeMs, files: scanned.value.length, sessions });
}

function observeIndex(indexPath: string): Result<IndexObservation> {
  let db: Database | null = null;
  try {
    db = new Database(indexPath, { readonly: true });
    const rows = db.query(
      `SELECT
         session_id AS sessionId,
         path,
         file_mtime AS mtimeMs,
         file_size AS sizeBytes
       FROM sessions`,
    ).all() as RawIndexSession[];
    const status = db.query(
      `SELECT
         generation,
         indexed_at AS indexedAt,
         refreshed_at AS refreshedAt,
         last_error_at AS lastErrorAt,
         last_error AS lastError
       FROM catalogue_source_status
       WHERE singleton = 1`,
    ).get() as RawSourceStatus | null;
    if (status === null) return err(new Error("Catalogue source status row is missing."));

    let latestMtimeMs: number | null = null;
    const sessions = new Map<string, IndexSignature>();
    for (const row of rows) {
      sessions.set(row.sessionId, {
        path: row.path,
        mtimeMs: row.mtimeMs,
        sizeBytes: row.sizeBytes,
      });
      if (latestMtimeMs === null || row.mtimeMs > latestMtimeMs) latestMtimeMs = row.mtimeMs;
    }
    return ok({
      latestMtimeMs,
      sessions,
      generation: status.generation,
      indexedAt: status.indexedAt,
      refreshedAt: status.refreshedAt,
      lastErrorAt: status.lastErrorAt,
      lastError: status.lastError,
    });
  } catch (cause) {
    return err(new Error(`Cannot read catalogue index at ${indexPath}: ${(cause as Error).message}`));
  } finally {
    db?.close();
  }
}

function unavailableSourceIndex(
  message: string,
  staleAfterMs: number,
  source: SourceObservation | null,
  index: IndexObservation | null,
): CatalogueSourceIndexState {
  return {
    state: "unavailable",
    sourceLatestMtimeMs: source?.latestMtimeMs ?? null,
    indexedLatestMtimeMs: index?.latestMtimeMs ?? null,
    lagMs: null,
    staleAfterMs,
    sourceFiles: source?.files ?? 0,
    indexedSessions: index?.sessions.size ?? 0,
    outOfSyncSessions: 0,
    generation: index?.generation ?? null,
    indexedAt: index?.indexedAt ?? null,
    refreshedAt: index?.refreshedAt ?? null,
    lastErrorAt: index?.lastErrorAt ?? null,
    lastError: index?.lastError ? `${message} catalogue_source_status: ${index.lastError}` : message,
  };
}

function classifySourceIndex(
  source: SourceObservation,
  index: IndexObservation,
  staleAfterMs: number,
  nowMs: number,
): CatalogueSourceIndexState {
  let lagMs = 0;
  let outOfSyncSessions = 0;

  for (const [sessionId, sourceSession] of source.sessions) {
    const indexedSession = index.sessions.get(sessionId);
    if (!indexedSession) {
      const sourceAgeMs = Math.max(0, nowMs - sourceSession.mtimeMs);
      const gapFromIndexHead = index.latestMtimeMs === null
        ? sourceAgeMs
        : Math.max(0, sourceSession.mtimeMs - index.latestMtimeMs);
      lagMs = Math.max(lagMs, gapFromIndexHead);
      if (index.sessions.size === 0 || sourceAgeMs > staleAfterMs || gapFromIndexHead > staleAfterMs) {
        outOfSyncSessions++;
      }
      continue;
    }

    const sessionLagMs = Math.max(0, sourceSession.mtimeMs - indexedSession.mtimeMs);
    const sourceRolledBack = sourceSession.mtimeMs < indexedSession.mtimeMs;
    const changedAtSameMtime =
      sourceSession.mtimeMs === indexedSession.mtimeMs &&
      sourceSession.sizeBytes !== indexedSession.sizeBytes;
    lagMs = Math.max(lagMs, sessionLagMs);
    if (
      sourceSession.path !== indexedSession.path ||
      sourceRolledBack ||
      changedAtSameMtime ||
      sessionLagMs > staleAfterMs
    ) {
      outOfSyncSessions++;
    }
  }

  for (const sessionId of index.sessions.keys()) {
    if (!source.sessions.has(sessionId)) outOfSyncSessions++;
  }

  const state = outOfSyncSessions === 0 ? "fresh" : "stale";
  return {
    state,
    sourceLatestMtimeMs: source.latestMtimeMs,
    indexedLatestMtimeMs: index.latestMtimeMs,
    lagMs,
    staleAfterMs,
    sourceFiles: source.files,
    indexedSessions: index.sessions.size,
    outOfSyncSessions,
    generation: index.generation,
    indexedAt: index.indexedAt,
    refreshedAt: index.refreshedAt,
    lastErrorAt: index.lastErrorAt,
    lastError: index.lastError,
  };
}

/** Inspect transcript stat metadata and the persisted index without starting or mutating the daemon. */
export async function checkCatalogueService(
  options: CatalogueCheckOptions = {},
): Promise<CatalogueCheckReport> {
  const configPath = options.configPath ?? CONFIG_PATH();
  const indexPath = options.indexPath ?? DB_PATH();
  const lockPath = options.lockPath ?? CATALOGUE_SERVICE_LOCK_PATH();
  const staleAfterMs = options.staleAfterMs ?? CATALOGUE_SOURCE_STALE_AFTER_MS;
  const nowMs = options.nowMs ?? Date.now();
  const inspectService = options.inspectService ?? inspectCatalogueServiceProcess;

  const sourceResult = observeSource(configPath);
  const indexResult = observeIndex(indexPath);
  let sourceIndex: CatalogueSourceIndexState;
  if (sourceResult.ok && indexResult.ok) {
    sourceIndex = classifySourceIndex(sourceResult.value, indexResult.value, staleAfterMs, nowMs);
  } else {
    const messages = [
      sourceResult.ok ? null : sourceResult.error.message,
      indexResult.ok ? null : indexResult.error.message,
    ].filter((message): message is string => message !== null);
    sourceIndex = unavailableSourceIndex(
      messages.join(" "),
      staleAfterMs,
      sourceResult.ok ? sourceResult.value : null,
      indexResult.ok ? indexResult.value : null,
    );
  }

  const service = inspectService(lockPath);
  return {
    healthy: sourceIndex.state === "fresh",
    service,
    sourceIndex,
  };
}
