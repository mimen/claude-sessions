import type { Database } from "bun:sqlite";
import { getAll, getRow, setEnrichment, recordEnrichmentFailure } from "../catalogue/db.ts";
import { getSkeleton, listByRecency, type SessionRow } from "../index/index.ts";
import { err, ok, type Result } from "../result.ts";
import type { Enrichment } from "../catalogue/enrichment-schema.ts";
import { loadEnrichmentLocations, type EnrichmentLocation } from "./locations.ts";
import { readTranscriptTail } from "./transcript-tail.ts";
import { requestEnrichment, type EnrichOptions } from "./gateway.ts";
import { enrichmentStaleness, type StaleReason } from "./staleness.ts";

/**
 * Enrichment orchestration: turn one session into a stored enrichment, and sweep the ones that
 * need it.
 *
 * Shaped after `backfillTitles` in `src/titler/queue.ts`, which solved the same problem for
 * titles: bounded concurrency so a backfill doesn't open 340 sockets, a capped attempt counter so
 * one pathological session doesn't consume a slot forever, and cancellation so a caller tearing
 * down its database doesn't get writes after close.
 */

export interface EnrichCandidate {
  readonly row: SessionRow;
  readonly reason: StaleReason;
  readonly messagesSince: number;
}

export interface SweepOptions extends EnrichOptions {
  readonly concurrency?: number;
  /** Stop after this many sessions. The first run over a cold store is the case this exists for. */
  readonly limit?: number;
  readonly onProgress?: (done: number, total: number, sessionId: string) => void;
  readonly isCancelled?: () => boolean;
  readonly now?: () => Date;
  /** Injected in tests; production reads the machine's registry. */
  readonly locations?: readonly EnrichmentLocation[];
}

export interface SweepStats {
  enriched: number;
  failed: number;
  /** Sessions that were stale but not reached because `limit` cut the run short. */
  remaining: number;
}

const DEFAULT_CONCURRENCY = 3;

/**
 * Sessions worth enriching, most recently active first.
 *
 * Top-level only, on two axes that mean different things: `isSubagent` excludes transcripts whose
 * every message is a sidechain (a subagent run, not a work body), and `auxiliary` excludes
 * declared delegated children. Neither is something you "catch up on" — you catch up on the
 * session that spawned them, whose transcript already covers the delegation.
 */
export function enrichCandidates(
  index: Database,
  catalogue: Database,
  now: Date = new Date(),
): EnrichCandidate[] {
  const catalogueRows = getAll(catalogue);
  const candidates: EnrichCandidate[] = [];
  for (const row of listByRecency(index, false)) {
    if (row.isSubagent) continue;
    const catalogueRow = catalogueRows.get(row.sessionId);
    if (catalogueRow?.sessionClass === "auxiliary") continue;
    const verdict = enrichmentStaleness({
      messageCount: row.msgCount,
      enrichment: catalogueRow?.enrichment,
      attempts: catalogueRow?.enrichmentAttempts ?? 0,
      now,
    });
    if (!verdict.stale) continue;
    candidates.push({ row, reason: verdict.reason, messagesSince: verdict.messagesSince });
  }
  return candidates;
}

/** Enrich one session and persist it. Failures bump the attempt counter and never throw. */
export async function enrichOne(
  catalogue: Database,
  index: Database,
  row: SessionRow,
  locations: readonly EnrichmentLocation[],
  options: EnrichOptions = {},
): Promise<Result<Enrichment>> {
  let tail: { text: string; truncated: boolean };
  try {
    tail = await readTranscriptTail(row.path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    recordEnrichmentFailure(catalogue, row.sessionId, new Date().toISOString());
    return err(new Error(`transcript unreadable: ${detail}`));
  }

  const response = await requestEnrichment(
    {
      title: row.title,
      cwd: row.cwd,
      messageCount: row.msgCount,
      lastActivity: row.lastTs,
      skeleton: getSkeleton(index, row.sessionId),
      tail: tail.text,
      tailTruncated: tail.truncated,
    },
    locations,
    options,
  );

  const nowIso = new Date().toISOString();
  if (!response.ok) {
    recordEnrichmentFailure(catalogue, row.sessionId, nowIso);
    return response;
  }

  // Stamp the message count we actually SAW, not a later one: staleness is measured against the
  // transcript this summary describes, so reading it from anywhere else would silently under-report
  // how out of date the summary is.
  const enrichment: Enrichment = {
    ...response.value,
    atMessages: row.msgCount,
    at: nowIso,
  };
  setEnrichment(catalogue, row.sessionId, enrichment, nowIso);
  return ok(enrichment);
}

/**
 * Enrich every stale session, `concurrency` at a time.
 *
 * A worker-pool over a shared cursor rather than chunked batches: session transcripts vary from a
 * few turns to thousands, so fixed batches would spend most of the run waiting on one straggler
 * while other workers idle.
 */
export async function sweep(
  index: Database,
  catalogue: Database,
  options: SweepOptions = {},
): Promise<SweepStats> {
  const now = options.now ?? (() => new Date());
  const locations = options.locations ?? loadEnrichmentLocations();
  const all = enrichCandidates(index, catalogue, now());
  const limit = options.limit ?? all.length;
  const candidates = all.slice(0, limit);
  const stats: SweepStats = { enriched: 0, failed: 0, remaining: all.length - candidates.length };

  let cursor = 0;
  let done = 0;
  const workerCount = Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, candidates.length);

  const worker = async (): Promise<void> => {
    while (true) {
      if (options.isCancelled?.()) return;
      const next = cursor++;
      if (next >= candidates.length) return;
      const candidate = candidates[next]!;
      const result = await enrichOne(catalogue, index, candidate.row, locations, options);
      // Re-check cancellation before touching stats/progress: a caller that cancelled mid-call is
      // usually about to close the database this loop would otherwise keep reporting against.
      if (options.isCancelled?.()) return;
      if (result.ok) stats.enriched++;
      else stats.failed++;
      done++;
      options.onProgress?.(done, candidates.length, candidate.row.sessionId);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return stats;
}

/** Read one session's stored enrichment, or null. Thin, but keeps consumers off `getRow` internals. */
export function storedEnrichment(catalogue: Database, sessionId: string) {
  return getRow(catalogue, sessionId)?.enrichment ?? null;
}
