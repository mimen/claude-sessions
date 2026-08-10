import type { Database } from "bun:sqlite";
import { getAll, getRow } from "../catalogue/db-queries.ts";
import { ensureRow, setEnrichment, recordEnrichmentFailure } from "../catalogue/db-mutations.ts";
import { getSkeleton, listByRecency, type SessionRow } from "../index/index.ts";
import { err, ok, type Result } from "../result.ts";
import type { Enrichment } from "../catalogue/enrichment-schema.ts";
import { loadEnrichmentLocations, type EnrichmentLocation } from "./locations.ts";
import { readTranscriptTail, type TranscriptTail } from "./transcript-tail.ts";
import { requestEnrichment, TransientGatewayError, type EnrichOptions } from "./gateway.ts";
import { readWorldState, renderWorldBlock } from "./world.ts";
import { recordSweepFailure, recordSweepSuccess } from "./health.ts";
import { enrichmentStaleness, type StaleReason } from "./staleness.ts";
import { incognitoSessionIds, isIncognito } from "../catalogue/incognito.ts";
import { CATEGORY_REGISTRY_PATH, LOCATION_REGISTRY_PATH } from "../paths.ts";
import { loadCategoryRegistry } from "../categories/registry.ts";
import { categoryStaleness, type CategoryStaleReason } from "../categories/staleness.ts";
import { classifyCategory } from "../categories/classify.ts";
import { getAllCategoryAssignments, getCategoryAssignment, getCategoryAttemptState, recordCategoryAttemptFailure, setCategory } from "../categories/assignment.ts";
import { loadLocationRegistry } from "../locations/registry.ts";

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
  readonly reason: StaleReason | CategoryStaleReason;
  readonly proseReason: StaleReason;
  readonly proseStale: boolean;
  readonly categoryReasons: readonly CategoryStaleReason[];
  readonly categoryEligible: boolean;
  readonly needsModelFallback: boolean;
  readonly messagesSince: number;
}

export interface SweepOptions extends EnrichOptions {
  readonly concurrency?: number;
  /** Stop after this many sessions. The first run over a cold store is the case this exists for. */
  readonly limit?: number;
  readonly onProgress?: (done: number, total: number, sessionId: string) => void;
  /**
   * Called once per failed session. The sweep's own counters say only "failed 12", which is
   * useless in an unattended launchd log — a broken gateway, an expired key, and one pathological
   * transcript all look identical until the reason is surfaced.
   */
  readonly onFailure?: (sessionId: string, error: Error) => void;
  readonly isCancelled?: () => boolean;
  readonly now?: () => Date;
  /** Injected in tests; production reads the machine's registry. */
  readonly locations?: readonly EnrichmentLocation[];
  /** Injected in tests so a sweep never writes to the real machine's health file. */
  readonly healthPath?: string;
}

export interface SweepStats {
  enriched: number;
  failed: number;
  /** Sessions that were stale but not reached because `limit` cut the run short. */
  remaining: number;
  /** Set when the sweep gave up early because the gateway was clearly unavailable. */
  abortedReason?: string;
}

const DEFAULT_CONCURRENCY = 3;

/**
 * Consecutive transport failures before a sweep concludes the gateway is down and stops.
 *
 * Without this, a provider cooldown produces a sweep that dutifully fails every single candidate
 * — the first real run hit 40 for 40 — which wastes minutes, floods the log, and tells you
 * nothing you didn't know after the third one. The next scheduled run picks the work back up.
 */
const TRANSIENT_FAILURE_LIMIT = 3;

function storedCategoryOnlyResult(
  catalogue: Database,
  row: SessionRow,
): Result<Enrichment> | null {
  const stored = getAll(catalogue).get(row.sessionId)?.enrichment;
  if (!stored?.recommendation) return null;
  return ok({
    title: stored.title ?? row.title,
    state: stored.state ?? "Category updated without regenerating prose.",
    history: stored.history ?? "",
    next: stored.next ?? "",
    remaining: stored.remaining ?? "",
    recommendation: stored.recommendation,
    reason: stored.reason ?? "",
    junk: stored.junk,
    ...(stored.cwdCorrect === null ? {} : { cwdCorrect: stored.cwdCorrect }),
    ...(stored.suggestedLocation ? { suggestedLocation: stored.suggestedLocation } : {}),
    ...(stored.suggestedCwd ? { suggestedCwd: stored.suggestedCwd } : {}),
    atMessages: stored.atMessages ?? row.msgCount,
    at: stored.at ?? new Date().toISOString(),
  });
}

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
  const registry = loadCategoryRegistry(CATEGORY_REGISTRY_PATH());
  const assignments = registry.ok ? getAllCategoryAssignments(catalogue) : new Map();
  const tagsBySession = new Map<string, string[]>();
  if (registry.ok) {
    for (const tag of catalogue.query("SELECT session_id, entity FROM session_tags WHERE entity LIKE 'domain:%'").all() as Array<{ session_id: string; entity: string }>) {
      const tags = tagsBySession.get(tag.session_id) ?? [];
      tags.push(tag.entity);
      tagsBySession.set(tag.session_id, tags);
    }
  }
  const candidates: EnrichCandidate[] = [];
  for (const row of listByRecency(index, false)) {
    if (row.isSubagent) continue;
    const catalogueRow = catalogueRows.get(row.sessionId);
    // The load-bearing suppression. Enrichment POSTs a transcript tail to the model gateway, so
    // for an incognito session this skip is the difference between the label meaning something
    // and it meaning nothing at all.
    if (isIncognito(catalogueRow)) continue;
    if (catalogueRow?.sessionClass === "auxiliary") continue;
    if (catalogueRow?.meta.workflowJournal === true || catalogueRow?.meta.workflow_journal === true || catalogueRow?.meta.journal === true) continue;
    const verdict = enrichmentStaleness({
      messageCount: row.msgCount,
      enrichment: catalogueRow?.enrichment,
      attempts: catalogueRow?.enrichmentAttempts ?? 0,
      now,
    });
    const categoryVerdict = registry.ok
      ? categoryStaleness({
          assignment: assignments.get(row.sessionId),
          tags: tagsBySession.get(row.sessionId) ?? [],
          registry: registry.value,
        })
      : { stale: false, reasons: [] as readonly CategoryStaleReason[], needsModelFallback: false };
    const categoryAttempt = registry.ok ? getCategoryAttemptState(catalogue, row.sessionId) : null;
    const categoryEligible = categoryVerdict.stale && categoryAttempt !== null
      && categoryAttempt.attempts < 5
      && (categoryAttempt.nextAttemptAt === null || Date.parse(categoryAttempt.nextAttemptAt) <= now.getTime());
    if (!verdict.stale && !categoryVerdict.stale) continue;
    candidates.push({
      row,
      reason: verdict.stale ? verdict.reason : categoryVerdict.reasons[0]!,
      proseReason: verdict.reason,
      proseStale: verdict.stale,
      categoryReasons: categoryVerdict.reasons,
      categoryEligible,
      needsModelFallback: categoryEligible && categoryVerdict.needsModelFallback,
      messagesSince: verdict.messagesSince,
    });
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
  const categoryRegistry = loadCategoryRegistry(CATEGORY_REGISTRY_PATH());
  let categoryChoices: EnrichOptions["categoryChoices"] = undefined;
  if (categoryRegistry.ok && options.categoryWork !== false) {
    try {
      const nowIso = new Date().toISOString();
      ensureRow(catalogue, row.sessionId, nowIso);
      const catalogueRow = getAll(catalogue).get(row.sessionId);
      const existingCategory = getCategoryAssignment(catalogue, row.sessionId);
      if (existingCategory?.manualLock) {
        setCategory(catalogue, categoryRegistry.value, {
          sessionId: row.sessionId,
          auxiliaryPolicy: "reject",
          slug: existingCategory.slug,
          source: existingCategory.source,
          confidence: existingCategory.confidence,
          manualLock: true,
          evidence: existingCategory.evidence,
          classifiedAt: existingCategory.classifiedAt,
          allowLockedOverride: true,
        });
        if (options.categoryOnly) {
          const storedResult = storedCategoryOnlyResult(catalogue, row);
          if (storedResult) return storedResult;
        }
      }
      const locationRegistry = loadLocationRegistry(LOCATION_REGISTRY_PATH());
      const classified = classifyCategory({
        registry: categoryRegistry.value,
        locations: locationRegistry.ok ? locationRegistry.value : null,
        locationKey: typeof catalogueRow?.meta.launch_location === "string" ? catalogueRow.meta.launch_location : null,
        cwd: row.cwd,
        parentSessionId: catalogueRow?.parentSessionId,
        catalogue,
      });
      if (classified.status === "resolved") {
        setCategory(catalogue, categoryRegistry.value, {
          sessionId: row.sessionId,
          auxiliaryPolicy: "reject",
          slug: classified.value.slug,
          source: classified.value.source,
          confidence: classified.value.confidence,
          evidence: classified.value.evidence,
          classifiedAt: nowIso,
        });
        if (options.categoryOnly) {
          const storedResult = storedCategoryOnlyResult(catalogue, row);
          if (storedResult) return storedResult;
        }
      } else if (existingCategory && !existingCategory.manualLock && !options.needsModelFallback) {
        setCategory(catalogue, categoryRegistry.value, {
          sessionId: row.sessionId,
          auxiliaryPolicy: "reject",
          slug: existingCategory.slug,
          source: existingCategory.source,
          confidence: existingCategory.confidence,
          evidence: existingCategory.evidence,
          classifiedAt: nowIso,
          allowLockedOverride: true,
        });
        if (options.categoryOnly) {
          const storedResult = storedCategoryOnlyResult(catalogue, row);
          if (storedResult) return storedResult;
        }
      } else if (!existingCategory?.manualLock && options.needsModelFallback) {
        categoryChoices = categoryRegistry.value.categories.map((category) => ({ slug: category.slug, name: category.name }));
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      recordCategoryAttemptFailure(catalogue, row.sessionId, error, new Date());
      if (options.categoryOnly) return err(error);
    }
  }

  let tail: TranscriptTail;
  try {
    tail = await readTranscriptTail(row.path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    recordEnrichmentFailure(catalogue, row.sessionId, new Date().toISOString());
    return err(new Error(`transcript unreadable: ${detail}`));
  }

  // Measured before the call, so the verdict is formed against the repository as it stands rather
  // than against the transcript alone. The dossier recomputes this at render time for the same
  // reason it is worth having: world state moves while a session sits still.
  const world = readWorldState(index, {
    sessionId: row.sessionId,
    cwd: row.cwd,
    branch: row.branch,
    lastTs: row.lastTs,
  }, incognitoSessionIds(catalogue));

  const response = await requestEnrichment(
    {
      title: row.title,
      cwd: row.cwd,
      messageCount: row.msgCount,
      lastActivity: row.lastTs,
      skeleton: getSkeleton(index, row.sessionId),
      tail: tail.text,
      tailTruncated: tail.truncated,
      arc: tail.arc,
      world: renderWorldBlock(world),
    },
    locations,
    { ...options, categoryChoices },
  );

  const nowIso = new Date().toISOString();
  if (!response.ok) {
    // Transient transport failures say nothing about this session, so they must not spend its
    // permanent attempt budget — see TransientGatewayError.
    if (!(response.error instanceof TransientGatewayError)) {
      if (options.categoryOnly || options.needsModelFallback) {
        recordCategoryAttemptFailure(catalogue, row.sessionId, response.error, new Date(nowIso));
      }
      if (!options.categoryOnly) recordEnrichmentFailure(catalogue, row.sessionId, nowIso);
    }
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
  if (categoryRegistry.ok && response.value.categorySlug) {
    try {
      setCategory(catalogue, categoryRegistry.value, {
        sessionId: row.sessionId,
        auxiliaryPolicy: "reject",
        slug: response.value.categorySlug,
        source: "model",
        confidence: 0.6,
        evidence: "forced-schema enrichment fallback",
        classifiedAt: nowIso,
      });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      recordCategoryAttemptFailure(catalogue, row.sessionId, error, new Date(nowIso));
      if (options.categoryOnly) return err(error);
    }
  }
  if (options.categoryOnly) {
    const storedResult = storedCategoryOnlyResult(catalogue, row);
    if (storedResult) return storedResult;
  }
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
  const all = enrichCandidates(index, catalogue, now())
    .filter((candidate) => candidate.proseStale || candidate.categoryEligible);
  const limit = options.limit ?? all.length;
  const candidates = all.slice(0, limit);
  const stats: SweepStats = { enriched: 0, failed: 0, remaining: all.length - candidates.length };

  let cursor = 0;
  let done = 0;
  let consecutiveTransient = 0;
  let aborted = false;
  const workerCount = Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, candidates.length);

  const worker = async (): Promise<void> => {
    while (true) {
      if (aborted || options.isCancelled?.()) return;
      const next = cursor++;
      if (next >= candidates.length) return;
      const candidate = candidates[next]!;
      let result: Result<Enrichment>;
      try {
        result = await enrichOne(catalogue, index, candidate.row, locations, {
          ...options,
          needsModelFallback: candidate.needsModelFallback,
          categoryWork: candidate.categoryEligible,
          categoryOnly: candidate.categoryEligible && !candidate.proseStale,
        });
      } catch (cause) {
        result = err(cause instanceof Error ? cause : new Error(String(cause)));
      }
      // Re-check cancellation before touching stats/progress: a caller that cancelled mid-call is
      // usually about to close the database this loop would otherwise keep reporting against.
      if (options.isCancelled?.()) return;
      if (result.ok) {
        stats.enriched++;
        // Any success proves the gateway is alive, so an intermittent limit never trips the breaker.
        consecutiveTransient = 0;
      } else {
        stats.failed++;
        options.onFailure?.(candidate.row.sessionId, result.error);
        if (result.error instanceof TransientGatewayError) {
          consecutiveTransient++;
          if (consecutiveTransient >= TRANSIENT_FAILURE_LIMIT) {
            aborted = true;
            stats.abortedReason = result.error.message;
          }
        } else {
          consecutiveTransient = 0;
        }
      }
      done++;
      options.onProgress?.(done, candidates.length, candidate.row.sessionId);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  // Everything not reached is still pending, whether the limit or the breaker stopped us.
  stats.remaining = all.length - stats.enriched - stats.failed;

  // Liveness, recorded so a dead runner is visible to readers rather than only to a log nobody
  // opens. A run that aborted on the transient breaker is a failure even though it enriched
  // nothing wrong — the store still stops advancing, which is the thing worth surfacing.
  if (!options.isCancelled?.()) {
    const nowIso = now().toISOString();
    if (stats.abortedReason) {
      recordSweepFailure(stats.abortedReason, nowIso, options.healthPath);
    } else if (stats.failed > 0 && stats.enriched === 0) {
      recordSweepFailure(`${stats.failed} sessions failed, none enriched`, nowIso, options.healthPath);
    } else {
      recordSweepSuccess(stats.enriched, nowIso, options.healthPath);
    }
  }
  return stats;
}

/** Read one session's stored enrichment, or null. Thin, but keeps consumers off `getRow` internals. */
export function storedEnrichment(catalogue: Database, sessionId: string) {
  return getRow(catalogue, sessionId)?.enrichment ?? null;
}
