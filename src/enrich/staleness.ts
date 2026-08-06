import type { StoredEnrichment } from "../catalogue/enrichment.ts";

/**
 * When an enrichment is worth regenerating.
 *
 * The cost model behind these rules: one pass over every session is cheap once, and free-ish
 * forever after IF re-runs are driven by how much a session actually moved rather than by a
 * clock. A timer-based sweep would re-enrich 340 finished sessions every night to discover that
 * none of them changed.
 */

/** Turns of progress that make a stored summary worth replacing. */
export const STALE_AFTER_MESSAGES = 10;

/**
 * Backstop for sessions that advance slowly. Below the message threshold a long-running session
 * could stay "fresh" for days on a handful of turns, so once it has moved at all and the stored
 * enrichment is this old, re-run it.
 */
export const STALE_AFTER_HOURS = 6;

/**
 * Failed attempts before a session is left alone permanently. Mirrors the index's title backfill:
 * a transcript the model can't handle should cost a bounded number of calls, not one per sweep
 * forever. A later success resets the counter (see `setEnrichment`).
 */
export const MAX_ENRICHMENT_ATTEMPTS = 3;

export interface StalenessInput {
  /** Current message count from the index. */
  readonly messageCount: number;
  readonly enrichment: StoredEnrichment | null | undefined;
  readonly attempts: number;
  /** Injected so the decision is pure and testable. */
  readonly now: Date;
}

export type StaleReason =
  | "never-enriched"
  | "advanced"
  | "aged"
  | "fresh"
  | "attempts-exhausted"
  /** Stored before a field this version expects existed — re-run to fill it in. */
  | "incomplete";

export interface StalenessVerdict {
  readonly stale: boolean;
  readonly reason: StaleReason;
  /** Messages added since the stored enrichment. Drives the "not updated in X turns" UI. */
  readonly messagesSince: number;
}

/**
 * Decide whether one session needs re-enriching.
 *
 * Note what is deliberately NOT a trigger: bare "last activity moved". An earlier draft listed
 * resume-detection as its own rule, but any session that gains a single message has moved, so
 * that rule would have fired on every advance and made the message threshold decorative. The
 * genuine case behind it — a dormant session picked back up, adding only a few turns — is caught
 * by the age backstop instead, which requires real progress AND real elapsed time.
 */
export function enrichmentStaleness(input: StalenessInput): StalenessVerdict {
  const { enrichment, attempts, messageCount, now } = input;
  if (!enrichment) {
    // Attempts are only consulted for sessions that have failed before; a never-enriched session
    // with a burnt budget is one the model has already refused several times.
    if (attempts >= MAX_ENRICHMENT_ATTEMPTS) {
      return { stale: false, reason: "attempts-exhausted", messagesSince: 0 };
    }
    return { stale: true, reason: "never-enriched", messagesSince: messageCount };
  }

  // Full catalogue hydration used to synthesize zero for a missing stored count. Keep that cadence
  // fallback here while the canonical storage shape reports the absence honestly as null.
  const messagesSince = Math.max(0, messageCount - (enrichment.atMessages ?? 0));
  if (attempts >= MAX_ENRICHMENT_ATTEMPTS) {
    return { stale: false, reason: "attempts-exhausted", messagesSince };
  }
  // An enrichment written before a field existed is incomplete, not fresh. Treating it as stale
  // makes the sweep its own backfill: the store heals itself on the normal schedule instead of
  // needing a one-off migration script that re-runs every session at once.
  if (!enrichment.title) {
    return { stale: true, reason: "incomplete", messagesSince };
  }
  // v40's cutover rides the same mechanism. A row enriched under v39 has prose in
  // `enrichment_summary` and nothing in `enrichment_state`, so it is incomplete by exactly the
  // definition above — no `--force` flag, no one-off migration script, and no risk of a stray
  // `--force` re-enriching the whole store by accident later. `enrichmentFrom` falls back to the
  // v39 text while this drains, so every panel stays readable in the meantime.
  //
  // `legacyShape`, not `!state`: the fallback fills `state` from the old column, so the obvious
  // check would report the entire v39 store as fresh and the cutover would silently never run.
  if (enrichment.legacyShape) {
    return { stale: true, reason: "incomplete", messagesSince };
  }
  if (messagesSince >= STALE_AFTER_MESSAGES) {
    return { stale: true, reason: "advanced", messagesSince };
  }
  if (messagesSince > 0) {
    const enrichedAtMs = Date.parse(enrichment.at ?? "");
    // An unparseable timestamp means the row is damaged; treat it as due rather than trusting it.
    if (Number.isNaN(enrichedAtMs)) {
      return { stale: true, reason: "aged", messagesSince };
    }
    const hours = (now.getTime() - enrichedAtMs) / 3_600_000;
    if (hours >= STALE_AFTER_HOURS) {
      return { stale: true, reason: "aged", messagesSince };
    }
  }
  return { stale: false, reason: "fresh", messagesSince };
}

/**
 * How the dossier says an enrichment is out of date. Staleness has to be loud: a confidently
 * worded summary that silently describes a session as it was 40 turns ago is worse than no
 * summary, because the reader has no cue to distrust it.
 */
export function stalenessLabel(messagesSince: number): string | null {
  if (messagesSince <= 0) return null;
  return `not updated in ${messagesSince} turn${messagesSince === 1 ? "" : "s"}`;
}

/**
 * The staleness warning a reader should see, given everything we can cheaply observe.
 *
 * `stalenessLabel` alone is not enough, and for the same reason the sweep was blind: it counts
 * messages, the count comes from the index, and the index does not move for a live session. So the
 * sessions most likely to have drifted are exactly the ones it reports as current.
 *
 * When the transcript has been written since the enrichment but the index has not caught up, we
 * cannot say HOW far behind it is — only that it is. Saying so is strictly better than printing
 * nothing, because the failure being prevented is a reader trusting confident prose that describes
 * a session as it was hours ago.
 */
export function enrichmentDriftLabel(input: {
  readonly messagesSince: number;
  readonly enrichmentAt: string;
  readonly transcriptMtimeMs: number | null;
}): string | null {
  const exact = stalenessLabel(input.messagesSince);
  if (exact) return exact;
  const enrichedAtMs = Date.parse(input.enrichmentAt);
  if (Number.isNaN(enrichedAtMs) || input.transcriptMtimeMs === null) return null;
  if (input.transcriptMtimeMs <= enrichedAtMs) return null;
  return "session has moved since this was written";
}
