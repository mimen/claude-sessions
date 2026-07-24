import { realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import { openCatalogue } from "../catalogue/db.ts";
import { buildEngine, resolveEngine } from "../inference/engine.ts";
import {
  recordTitleFailure,
  reindexStore,
  saveCodexTitle,
  type ReindexStats,
} from "../index/index.ts";
import { openIndex } from "../index/schema.ts";
import { type Result, err, ok } from "../result.ts";
import { scanStore } from "../store.ts";
import { backfillTitles, type BackfillStats } from "../titler/queue.ts";
import { createTitler } from "../titler/codex.ts";
import {
  CATALOGUE_PROTOCOL_VERSION,
  CLAUDE_PROVIDER_INSTANCE_ID,
  type CatalogueErrorCode,
  type CatalogueRefreshResult,
  type CatalogueRefreshStats,
  type CatalogueRootSession,
  type CatalogueSourceStatus,
  type RootSessionPage,
  type RootSessionQuery,
  type SourceLookupResult,
  type VerifiedCatalogueSource,
} from "./protocol.ts";
import {
  countRootSessions,
  queryRootSessions,
  sourceCandidates,
  toRootSession,
  type IndexedSourceCandidate,
} from "./query.ts";

const NATIVE_CLAUDE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PersistedSourceStatus {
  readonly generation: number;
  readonly indexedAt: string | null;
  readonly refreshedAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastError: string | null;
  readonly scanned: number;
  readonly parsed: number;
  readonly skipped: number;
  readonly removed: number;
}

export interface CatalogueAuthorityError {
  readonly code: CatalogueErrorCode;
  readonly message: string;
}

interface RefreshSummary {
  readonly stats: CatalogueRefreshStats;
  readonly totalBytes: number;
  readonly titles: BackfillStats | null;
}

export interface CatalogueAuthorityOptions {
  readonly indexPath: string;
  readonly cataloguePath: string;
  readonly config: Config;
  readonly freshMs: number;
  readonly now?: () => number;
}

function error(code: CatalogueErrorCode, message: string): CatalogueAuthorityError {
  return { code, message };
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}

/**
 * Single source-index authority. It is the only daemon component allowed to call scanStore /
 * reindexStore; all protocol handlers share its one coalesced refresh promise.
 */
export class CatalogueAuthority {
  readonly #db: Database;
  readonly #config: Config;
  readonly #freshMs: number;
  readonly #now: () => number;
  readonly #canonicalStore: string;
  #catalogueDataVersion = 0;
  #refreshScheduled: ReturnType<typeof setTimeout> | null = null;
  #refreshPromise: Promise<Result<RefreshSummary, CatalogueAuthorityError>> | null = null;

  constructor(options: CatalogueAuthorityOptions) {
    this.#config = options.config;
    this.#freshMs = options.freshMs;
    this.#now = options.now ?? Date.now;
    this.#canonicalStore = resolve(options.config.store.path);

    // Materialize/migrate CCS's durable catalogue once, then attach it to the existing incremental
    // index for root-only filtering. This is an internal join, never a cross-process SQLite API.
    const catalogue = openCatalogue(options.cataloguePath);
    catalogue.close();
    this.#db = openIndex(options.indexPath);
    this.#db.query("ATTACH DATABASE $path AS ccs_catalogue").run({ $path: options.cataloguePath });
    const generationBeforeVisibilitySync = this.#readPersistedStatus().generation;
    this.#db.exec("BEGIN IMMEDIATE;");
    try {
      const visibilityChanged = this.#syncHiddenSessions(false);
      this.#bootstrapGeneration();
      if (visibilityChanged && generationBeforeVisibilitySync > 0) this.#bumpGeneration();
      this.#db.exec("COMMIT;");
    } catch (cause) {
      this.#db.exec("ROLLBACK;");
      throw cause;
    }
    this.#catalogueDataVersion = this.#readCatalogueDataVersion();
  }

  get isRefreshing(): boolean {
    return this.#refreshPromise !== null || this.#refreshScheduled !== null;
  }

  sourceStatus(): CatalogueSourceStatus {
    const persisted = this.#readPersistedStatus();
    const now = this.#now();
    const refreshedMs = persisted.refreshedAt === null ? null : Date.parse(persisted.refreshedAt);
    const ageMs = refreshedMs === null || !Number.isFinite(refreshedMs)
      ? null
      : Math.max(0, now - refreshedMs);
    const freshness = ageMs === null ? "uninitialized" : ageMs <= this.#freshMs ? "fresh" : "stale";
    const hasLatestError = persisted.lastErrorAt !== null && (
      persisted.refreshedAt === null || persisted.lastErrorAt > persisted.refreshedAt
    );
    return {
      generation: persisted.generation,
      phase: this.isRefreshing ? "refreshing" : hasLatestError ? "error" : "idle",
      freshness,
      indexedAt: persisted.indexedAt,
      refreshedAt: persisted.refreshedAt,
      ageMs,
      staleAfterMs: this.#freshMs,
      rowCount: countRootSessions(this.#db),
      lastError: persisted.lastErrorAt && persisted.lastError
        ? { at: persisted.lastErrorAt, message: persisted.lastError }
        : null,
      lastRefresh: {
        scanned: persisted.scanned,
        parsed: persisted.parsed,
        skipped: persisted.skipped,
        removed: persisted.removed,
      },
    };
  }

  async prepareRead(
    requireFresh: boolean,
    options: { readonly startBackground?: boolean; readonly waitForInFlight?: boolean } = {},
  ): Promise<Result<CatalogueSourceStatus, CatalogueAuthorityError>> {
    if (this.#refreshPromise) {
      const status = this.sourceStatus();
      const waitForBootstrap = status.freshness === "uninitialized" && status.rowCount === 0;
      if (requireFresh || options.waitForInFlight === true || waitForBootstrap) {
        const inFlight = await this.#refreshPromise;
        if (!inFlight.ok && (requireFresh || waitForBootstrap)) return inFlight;
      } else {
        // Parsing does not hold a write transaction, so stale readers can safely return the last
        // committed snapshot while a refresh prepares its next atomic publication.
        return ok(status);
      }
    }
    this.#refreshVisibilityIfChanged();
    const status = this.sourceStatus();
    if (status.freshness === "fresh") return ok(status);

    if (requireFresh || (status.freshness === "uninitialized" && status.rowCount === 0)) {
      const refreshed = await this.refresh({ force: false, titles: false });
      if (!refreshed.ok) return refreshed;
      return ok(this.sourceStatus());
    }

    if (options.startBackground !== false) this.#scheduleBackgroundRefresh();
    return ok(this.sourceStatus());
  }

  async query(query: RootSessionQuery): Promise<Result<RootSessionPage, CatalogueAuthorityError>> {
    const requireFresh = query.freshness === "require-fresh";
    // Require-fresh readers and empty-store bootstrap followers wait for the in-flight refresh.
    // Other allow-stale readers return the last committed generation while parsing continues.
    const prepared = await this.prepareRead(requireFresh, {
      startBackground: false,
      waitForInFlight: requireFresh,
    });
    if (!prepared.ok) return prepared;
    const snapshotStatus = this.sourceStatus();
    const result = queryRootSessions(this.#db, query, snapshotStatus.generation, this.#now());
    if (!result.ok) return err(result.error);

    let responseStatus = snapshotStatus;
    if (!requireFresh && snapshotStatus.freshness !== "fresh") {
      // Start revalidation only after the synchronous page read, so rows and generation describe
      // one snapshot. A later cursor request will either wait for this refresh or get stale_cursor.
      this.#scheduleBackgroundRefresh();
      responseStatus = { ...snapshotStatus, phase: "refreshing" };
    }
    return ok({
      protocolVersion: CATALOGUE_PROTOCOL_VERSION,
      sessions: result.sessions,
      nextCursor: result.nextCursor,
      sourceStatus: responseStatus,
    });
  }

  async lookup(resumeId: string, cwd: string): Promise<Result<SourceLookupResult, CatalogueAuthorityError>> {
    if (!NATIVE_CLAUDE_SESSION_ID.test(resumeId)) {
      return err(error("invalid_resume_id", "Native Claude resume id must be a UUID."));
    }

    const prepared = await this.prepareRead(true);
    if (!prepared.ok) return prepared;
    let verified = this.#verifySource(resumeId, cwd);
    if (!verified.ok && verified.error.code === "source_changed") {
      const refreshed = await this.refresh({ force: true, titles: false });
      if (!refreshed.ok) return refreshed;
      verified = this.#verifySource(resumeId, cwd);
    }
    if (!verified.ok) return verified;
    return ok({
      protocolVersion: CATALOGUE_PROTOCOL_VERSION,
      source: verified.value,
      sourceStatus: this.sourceStatus(),
    });
  }

  async refresh(options: {
    readonly force: boolean;
    readonly titles: boolean;
  }): Promise<Result<RefreshSummary, CatalogueAuthorityError>> {
    if (this.#refreshScheduled) {
      clearTimeout(this.#refreshScheduled);
      this.#refreshScheduled = null;
    }
    if (!this.#refreshPromise) this.#refreshVisibilityIfChanged();
    const current = this.sourceStatus();
    if (!options.force && current.freshness === "fresh" && !options.titles) {
      return ok({
        stats: current.lastRefresh,
        totalBytes: this.#totalBytes(),
        titles: null,
      });
    }
    if (this.#refreshPromise) {
      if (!options.force && !options.titles) return this.#refreshPromise;
      // A stronger maintenance request must not be silently weakened by an existing background
      // refresh. Run it after the current publication finishes.
      return this.#refreshPromise.then(() => this.refresh(options));
    }

    const run = this.#runRefresh(options).catch((cause: Error) => {
      const failure = error("refresh_failed", `Catalogue refresh failed: ${cause.message}`);
      this.#markRefreshFailure(failure.message);
      return err(failure);
    });
    const tracked = run.finally(() => {
      if (this.#refreshPromise === tracked) this.#refreshPromise = null;
    });
    this.#refreshPromise = tracked;
    return tracked;
  }

  async controlRefresh(options: {
    readonly force: boolean;
    readonly titles: boolean;
  }): Promise<Result<CatalogueRefreshResult, CatalogueAuthorityError>> {
    const refreshed = await this.refresh(options);
    if (!refreshed.ok) return refreshed;
    const spend = this.#db.query("SELECT SUM(cost_usd) AS usd FROM sessions").get() as {
      usd: number | null;
    };
    const titles = refreshed.value.titles;
    return ok({
      protocolVersion: CATALOGUE_PROTOCOL_VERSION,
      sourceStatus: this.sourceStatus(),
      stats: refreshed.value.stats,
      totalBytes: refreshed.value.totalBytes,
      totalCostUSD: spend.usd ?? 0,
      storePath: this.#config.store.path,
      host: this.#config.host.label,
      titles: titles
        ? {
            generated: titles.generated,
            failed: titles.failed,
            skippedUnavailable: titles.skippedUnavailable === true,
          }
        : null,
    });
  }

  async saveTitle(sessionId: string, title: string): Promise<Result<void, CatalogueAuthorityError>> {
    if (this.#refreshPromise) await this.#refreshPromise;
    const normalized = title.trim();
    if (!sessionId.trim() || !normalized || normalized.length > 500) {
      return err(error("bad_request", "Session id and a title of at most 500 characters are required."));
    }
    if (!this.#sessionExists(sessionId)) {
      return err(error("source_not_found", "Cannot title a session that is not indexed."));
    }
    saveCodexTitle(this.#db, sessionId, normalized);
    return ok(undefined);
  }

  async recordTitleFailure(sessionId: string): Promise<Result<void, CatalogueAuthorityError>> {
    if (this.#refreshPromise) await this.#refreshPromise;
    if (!sessionId.trim()) return err(error("bad_request", "Session id is required."));
    if (!this.#sessionExists(sessionId)) {
      return err(error("source_not_found", "Cannot update a session that is not indexed."));
    }
    recordTitleFailure(this.#db, sessionId);
    return ok(undefined);
  }

  async close(): Promise<void> {
    if (this.#refreshScheduled) {
      clearTimeout(this.#refreshScheduled);
      this.#refreshScheduled = null;
    }
    if (this.#refreshPromise) await this.#refreshPromise;
    this.#db.close();
  }

  #scheduleBackgroundRefresh(): void {
    if (this.#refreshScheduled || this.#refreshPromise) return;
    this.#refreshScheduled = setTimeout(() => {
      this.#refreshScheduled = null;
      void this.refresh({ force: false, titles: false });
    }, 0);
  }

  async #runRefresh(options: {
    readonly force: boolean;
    readonly titles: boolean;
  }): Promise<Result<RefreshSummary, CatalogueAuthorityError>> {
    if (!options.force && this.sourceStatus().freshness === "fresh" && !options.titles) {
      const status = this.sourceStatus();
      return ok({ stats: status.lastRefresh, totalBytes: this.#totalBytes(), titles: null });
    }

    const scan = scanStore(this.#canonicalStore);
    if (!scan.ok) {
      const failure = error("refresh_failed", scan.error.message);
      this.#markRefreshFailure(failure.message);
      return err(failure);
    }

    const totalBytes = scan.value.reduce((sum, file) => sum + file.sizeBytes, 0);
    const catalogueDataVersionBeforePublication = this.#readCatalogueDataVersion();
    const stats = await reindexStore(this.#db, scan.value, this.#config.host.label, {
      beforeCommit: (publishedStats) => {
        const visibilityChanged = this.#syncHiddenSessions(false);
        this.#markRefreshSuccess(publishedStats, visibilityChanged);
      },
    });
    this.#catalogueDataVersion = catalogueDataVersionBeforePublication;

    let titles: BackfillStats | null = null;
    if (options.titles) {
      const selection = resolveEngine(this.#config);
      const engine = selection.name ? buildEngine(selection.name, this.#config) : null;
      const titler = engine ? createTitler(engine) : null;
      titles = titler
        ? await backfillTitles(this.#db, titler, {
            concurrency: this.#config.titler.concurrency,
            maxAttempts: this.#config.titler.maxAttempts,
          })
        : { generated: 0, failed: 0, skippedUnavailable: true };
    }
    return ok({ stats, totalBytes, titles });
  }

  #verifySource(
    resumeId: string,
    requestedCwd: string,
  ): Result<VerifiedCatalogueSource, CatalogueAuthorityError> {
    let canonicalRequestedCwd: string;
    try {
      canonicalRequestedCwd = realpathSync(requestedCwd);
      if (!statSync(canonicalRequestedCwd).isDirectory()) {
        return err(error("invalid_cwd", "Requested Claude source CWD is not a directory."));
      }
    } catch {
      return err(error("invalid_cwd", "Requested Claude source CWD does not exist."));
    }

    const candidates = sourceCandidates(this.#db, resumeId);
    if (candidates.length === 0) {
      return err(error("source_not_found", "Claude session was not found in the configured store."));
    }

    const matching: Array<{ readonly row: IndexedSourceCandidate; readonly cwd: string }> = [];
    for (const row of candidates) {
      try {
        const canonicalCwd = realpathSync(row.cwd);
        if (statSync(canonicalCwd).isDirectory() && canonicalCwd === canonicalRequestedCwd) {
          matching.push({ row, cwd: canonicalCwd });
        }
      } catch {
        // An indexed source whose recorded CWD vanished is not a valid continuation candidate.
      }
    }
    if (matching.length === 0) {
      return err(error("cwd_mismatch", "Requested CWD does not match the native Claude source."));
    }
    if (matching.length > 1) {
      return err(error("source_ambiguous", "More than one Claude source has this resume id and CWD."));
    }

    const match = matching[0]!;
    let canonicalPath: string;
    try {
      const canonicalStore = realpathSync(this.#canonicalStore);
      canonicalPath = realpathSync(match.row.sourcePath);
      if (!canonicalPath.endsWith(".jsonl") || !isWithin(canonicalStore, canonicalPath)) {
        return err(error("source_not_found", "Claude source is outside the configured store."));
      }
      const stat = statSync(canonicalPath);
      if (!stat.isFile()) {
        return err(error("source_not_found", "Claude source is not a regular file."));
      }
      if (
        stat.size !== match.row.observedSize ||
        Math.abs(stat.mtimeMs - match.row.observedMtimeMs) >= 1
      ) {
        return err(error("source_changed", "Claude source changed after the indexed snapshot."));
      }
      const root: CatalogueRootSession = toRootSession(match.row);
      return ok({
        ...root,
        providerInstanceId: CLAUDE_PROVIDER_INSTANCE_ID,
        sourceCwd: match.cwd,
        sourcePath: canonicalPath,
        fileIdentity: `${stat.dev}:${stat.ino}`,
      });
    } catch {
      return err(error("source_not_found", "Claude source no longer exists."));
    }
  }

  #readPersistedStatus(): PersistedSourceStatus {
    return this.#db
      .query(
        `SELECT
           generation,
           indexed_at AS indexedAt,
           refreshed_at AS refreshedAt,
           last_error_at AS lastErrorAt,
           last_error AS lastError,
           scanned,
           parsed,
           skipped,
           removed
         FROM catalogue_source_status
         WHERE singleton = 1`,
      )
      .get() as PersistedSourceStatus;
  }

  #bootstrapGeneration(): void {
    const persisted = this.#readPersistedStatus();
    const rowCount = countRootSessions(this.#db);
    if (persisted.generation !== 0 || rowCount === 0) return;
    this.#db
      .query(
        `UPDATE catalogue_source_status
         SET generation = 1, indexed_at = $now
         WHERE singleton = 1`,
      )
      .run({ $now: new Date(this.#now()).toISOString() });
  }

  #readCatalogueDataVersion(): number {
    const row = this.#db.query("PRAGMA ccs_catalogue.data_version").get() as { data_version: number };
    return row.data_version;
  }

  #refreshVisibilityIfChanged(): void {
    const current = this.#readCatalogueDataVersion();
    if (current === this.#catalogueDataVersion) return;
    this.#db.exec("BEGIN IMMEDIATE;");
    try {
      const changed = this.#syncHiddenSessions(false);
      if (changed) this.#bumpGeneration();
      this.#db.exec("COMMIT;");
    } catch (cause) {
      this.#db.exec("ROLLBACK;");
      throw cause;
    }
    this.#catalogueDataVersion = current;
  }

  #syncHiddenSessions(manageTransaction = true): boolean {
    const desiredRows = this.#db
      .query(
        `SELECT c.session_id AS sessionId
         FROM ccs_catalogue.catalogue AS c
         INNER JOIN sessions AS s ON s.session_id = c.session_id
         WHERE c.session_class = 'auxiliary'
            OR COALESCE(c.substrate, 'claude-code') <> 'claude-code'
         ORDER BY c.session_id ASC`,
      )
      .all() as Array<{ sessionId: string }>;
    const existingRows = this.#db
      .query("SELECT session_id AS sessionId FROM catalogue_hidden_sessions ORDER BY session_id ASC")
      .all() as Array<{ sessionId: string }>;
    const desired = desiredRows.map((row) => row.sessionId);
    const existing = existingRows.map((row) => row.sessionId);
    if (desired.length === existing.length && desired.every((id, index) => id === existing[index])) {
      return false;
    }

    if (manageTransaction) this.#db.exec("BEGIN IMMEDIATE;");
    try {
      this.#db.exec("DELETE FROM catalogue_hidden_sessions;");
      const insert = this.#db.query(
        "INSERT INTO catalogue_hidden_sessions (session_id) VALUES ($sessionId)",
      );
      for (const sessionId of desired) insert.run({ $sessionId: sessionId });
      if (manageTransaction) this.#db.exec("COMMIT;");
      return true;
    } catch (cause) {
      if (manageTransaction) this.#db.exec("ROLLBACK;");
      throw cause;
    }
  }

  #bumpGeneration(): void {
    const now = new Date(this.#now()).toISOString();
    this.#db
      .query(
        `UPDATE catalogue_source_status
         SET generation = generation + 1, indexed_at = $now
         WHERE singleton = 1`,
      )
      .run({ $now: now });
  }

  #markRefreshSuccess(stats: ReindexStats, visibilityChanged: boolean): void {
    const current = this.#readPersistedStatus();
    const now = new Date(this.#now()).toISOString();
    const changed = stats.parsed > 0 || stats.removed > 0 || visibilityChanged;
    const generation = current.generation === 0 ? 1 : changed ? current.generation + 1 : current.generation;
    const indexedAt = current.indexedAt === null || changed ? now : current.indexedAt;
    this.#db
      .query(
        `UPDATE catalogue_source_status
         SET generation = $generation,
             indexed_at = $indexedAt,
             refreshed_at = $now,
             last_error_at = NULL,
             last_error = NULL,
             scanned = $scanned,
             parsed = $parsed,
             skipped = $skipped,
             removed = $removed
         WHERE singleton = 1`,
      )
      .run({
        $generation: generation,
        $indexedAt: indexedAt,
        $now: now,
        $scanned: stats.scanned,
        $parsed: stats.parsed,
        $skipped: stats.skipped,
        $removed: stats.removed,
      });
  }

  #markRefreshFailure(message: string): void {
    this.#db
      .query(
        `UPDATE catalogue_source_status
         SET last_error_at = $now, last_error = $message
         WHERE singleton = 1`,
      )
      .run({ $now: new Date(this.#now()).toISOString(), $message: message });
  }

  #sessionExists(sessionId: string): boolean {
    return this.#db.query("SELECT 1 FROM sessions WHERE session_id = $sessionId").get({
      $sessionId: sessionId,
    }) !== null;
  }

  #totalBytes(): number {
    const row = this.#db.query("SELECT SUM(file_size) AS bytes FROM sessions").get() as {
      bytes: number | null;
    };
    return row.bytes ?? 0;
  }
}
