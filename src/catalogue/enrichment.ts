/**
 * Reading enrichment back out of the catalogue.
 *
 * `enrichment-schema.ts` owns the write side: what a valid enrichment is, and the vocabulary the
 * model may use. This is the read side, and it lives here rather than inside any one UI because
 * every reader must agree about what a session's verdict is. A verdict that disagreed between two
 * surfaces would be worse than showing none.
 *
 * The catalogue row type does not carry these columns, so they are queried directly. Roughly a
 * fifth of sessions have ever been enriched, so a missing enrichment is the normal case and yields
 * no entry rather than an empty record every caller would have to special-case.
 */
import type { Database } from "bun:sqlite";
import { RECOMMENDATIONS, type Recommendation } from "./enrichment-schema.ts";

/**
 * What enrichment concluded, as stored.
 *
 * v40 split the two prose fields that had been doing double duty: `summary` became `state` (where
 * it stands) plus `history` (how it got there), and `outstanding` became `next` (one imperative
 * action) plus `remaining`. Both generations are readable here, because the split was additive and
 * only recently-swept rows carry the new columns.
 */
export interface StoredEnrichment {
  /** Where the session stands now. The one field a reader is guaranteed to get. */
  readonly state: string;
  /** How it got there. Empty on a short session. */
  readonly history: string | null;
  /** The one thing to do first on resuming. Empty when nothing is open. */
  readonly next: string | null;
  /** Everything still open after `next`. */
  readonly remaining: string | null;
  /** What should happen to this session. */
  readonly recommendation: Recommendation | null;
  /**
   * Why the recommendation follows. Conditional by design: v40 requires it for archive, handoff and
   * junk, and requires it EMPTY for continue and complete, where it only ever restated the verdict.
   */
  readonly reason: string | null;
  /** Never worth starting. v40 makes junk imply an archive recommendation. */
  readonly junk: boolean;
  /** Transcript message count when the enrichment was written. */
  readonly atMessages: number | null;
  /** ISO timestamp of generation. */
  readonly at: string | null;
}

/** A stored enrichment plus how far the transcript has moved since it was written. */
export interface EnrichmentWithStaleness extends StoredEnrichment {
  readonly messagesSince: number | null;
}

/**
 * How far the transcript has moved since an enrichment was written, or null when either count is
 * unknown.
 *
 * Messages rather than turns: `enrichment_at_messages` is stamped from `msg_count`, so it has to be
 * compared against that same counter. Comparing it to `user_turns`, which runs 20-30x smaller,
 * would report every enrichment as wildly stale.
 */
export function messagesSince(
  enrichment: Pick<StoredEnrichment, "atMessages">,
  currentMessageCount: number | null | undefined,
): number | null {
  if (enrichment.atMessages === null) return null;
  if (currentMessageCount === null || currentMessageCount === undefined) return null;
  // A negative would say the transcript went backwards; an enrichment stamped ahead of the current
  // count is simply current.
  return Math.max(0, currentMessageCount - enrichment.atMessages);
}

function isRecommendation(value: string | null): value is Recommendation {
  return value !== null && (RECOMMENDATIONS as readonly string[]).includes(value);
}

/** Columns read opportunistically: absent ones are selected as NULL rather than failing the query. */
const OPTIONAL_COLUMNS = [
  "enrichment_state",
  "enrichment_summary",
  "enrichment_history",
  "enrichment_next",
  "enrichment_remaining",
  "enrichment_outstanding",
  "enrichment_recommendation",
  "enrichment_reason",
  "enrichment_junk",
  "enrichment_at_messages",
  "enrichment_at",
] as const;

/**
 * Every enrichment in the catalogue, keyed by session id and by resume alias so a resumed session
 * finds the record written under either identity.
 *
 * A catalogue predating any of these columns yields the fields it does have; one predating
 * enrichment entirely yields nothing.
 */
export function readEnrichments(db: Database): Map<string, StoredEnrichment> {
  const found = new Map<string, StoredEnrichment>();
  try {
    const columns = new Set(
      (db.query("PRAGMA table_info(catalogue)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );

    // `state` is v40's guaranteed field, `summary` its predecessor. Naming a column that does not
    // exist is a hard SQL error, so the filter is built from what is actually present, and with
    // neither there is no enrichment to read.
    const present = ["enrichment_state", "enrichment_summary"].filter((c) => columns.has(c));
    if (present.length === 0) return found;
    const where = present
      .map((column) => `(${column} IS NOT NULL AND TRIM(${column}) != '')`)
      .join(" OR ");

    const selected = OPTIONAL_COLUMNS
      .map((name) => (columns.has(name) ? name : `NULL AS ${name}`))
      .join(",\n              ");

    const rows = db.query(
      `SELECT session_id, resume_id,
              ${selected}
         FROM catalogue
        WHERE ${where}`,
    ).all() as Array<Record<string, string | number | null>>;

    const text = (value: string | number | null | undefined): string | null => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed.length > 0 ? trimmed : null;
    };

    for (const row of rows) {
      // v40's `state` wins wherever a sweep has produced one: it answers the same question more
      // directly than the legacy `summary`.
      const state = text(row.enrichment_state) ?? text(row.enrichment_summary);
      if (state === null) continue;

      const record: StoredEnrichment = {
        state,
        history: text(row.enrichment_history),
        // `outstanding` was v39's single open-work field; v40 promoted its first action to `next`.
        next: text(row.enrichment_next) ?? text(row.enrichment_outstanding),
        remaining: text(row.enrichment_remaining),
        recommendation: isRecommendation(text(row.enrichment_recommendation))
          ? (text(row.enrichment_recommendation) as Recommendation)
          : null,
        reason: text(row.enrichment_reason),
        junk: row.enrichment_junk === 1,
        atMessages: typeof row.enrichment_at_messages === "number"
          ? row.enrichment_at_messages
          : null,
        at: text(row.enrichment_at),
      };

      found.set(row.session_id as string, record);
      const resumeId = row.resume_id as string | null;
      if (resumeId) found.set(resumeId, record);
    }
  } catch {
    // An enrichment is a nicety; failing to read one must never cost the caller its lifecycle data.
  }
  return found;
}
