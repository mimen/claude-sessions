import type { Database } from "bun:sqlite";
import { RECOMMENDATIONS, type Recommendation } from "./enrichment-schema.ts";

/** Catalogue lifecycle vocabulary needed by recommendation decisions. */
export type RecommendationLifecycle = "idle" | "parked" | "completed" | "archived";

/**
 * The complete stored enrichment shape shared by catalogue, sidebar, staleness, and triage.
 *
 * Storage hydration stays literal: optional prose, timestamps, and counts are null when absent.
 * Callers own display defaults such as an empty line, the indexed title, or `continue`.
 */
export interface StoredEnrichment {
  readonly title: string | null;
  readonly state: string | null;
  readonly history: string | null;
  readonly next: string | null;
  readonly remaining: string | null;
  readonly recommendation: Recommendation | null;
  readonly reason: string | null;
  readonly junk: boolean;
  readonly cwdCorrect: boolean | null;
  readonly suggestedLocation: string | null;
  readonly suggestedCwd: string | null;
  readonly atMessages: number | null;
  readonly at: string | null;
  readonly legacyShape: boolean;
  readonly declined: Recommendation | null;
}

/** A stored enrichment plus how far the transcript has moved since it was written. */
export interface EnrichmentWithStaleness extends StoredEnrichment {
  readonly messagesSince: number | null;
}

/**
 * Every enrichment column a compatibility reader may select opportunistically.
 *
 * The legacy summary/outstanding columns remain inputs to the canonical fields until the additive
 * schema has fully drained. Readers decide which columns exist and select missing ones as NULL.
 */
export const OPTIONAL_ENRICHMENT_COLUMNS = [
  "enrichment_title",
  "enrichment_state",
  "enrichment_summary",
  "enrichment_history",
  "enrichment_next",
  "enrichment_remaining",
  "enrichment_outstanding",
  "enrichment_recommendation",
  "enrichment_reason",
  "enrichment_junk",
  "enrichment_cwd_correct",
  "enrichment_suggested_location",
  "enrichment_suggested_cwd",
  "enrichment_at_messages",
  "enrichment_at",
  "enrichment_declined",
] as const;

function text(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function recommendation(value: unknown): Recommendation | null {
  const candidate = text(value);
  return candidate !== null && (RECOMMENDATIONS as readonly string[]).includes(candidate)
    ? candidate as Recommendation
    : null;
}

/** Purely normalize one selected SQLite row into the canonical stored shape. */
export function hydrateStoredEnrichment(row: Readonly<Record<string, unknown>>): StoredEnrichment {
  const nativeState = text(row.enrichment_state);
  return {
    title: text(row.enrichment_title),
    state: nativeState ?? text(row.enrichment_summary),
    history: text(row.enrichment_history),
    next: text(row.enrichment_next) ?? text(row.enrichment_outstanding),
    remaining: text(row.enrichment_remaining),
    recommendation: recommendation(row.enrichment_recommendation),
    reason: text(row.enrichment_reason),
    junk: row.enrichment_junk === 1 || row.enrichment_junk === true,
    cwdCorrect: row.enrichment_cwd_correct === null || row.enrichment_cwd_correct === undefined
      ? null
      : row.enrichment_cwd_correct === 1 || row.enrichment_cwd_correct === true,
    suggestedLocation: text(row.enrichment_suggested_location),
    suggestedCwd: text(row.enrichment_suggested_cwd),
    atMessages: typeof row.enrichment_at_messages === "number"
      ? row.enrichment_at_messages
      : null,
    at: text(row.enrichment_at),
    legacyShape: nativeState === null && text(row.enrichment_summary) !== null,
    declined: recommendation(row.enrichment_declined),
  };
}

/**
 * How far the transcript has moved since an enrichment was written, or null when either count is
 * unknown.
 */
export function messagesSince(
  enrichment: Pick<StoredEnrichment, "atMessages">,
  currentMessageCount: number | null | undefined,
): number | null {
  if (enrichment.atMessages === null) return null;
  if (currentMessageCount === null || currentMessageCount === undefined) return null;
  return Math.max(0, currentMessageCount - enrichment.atMessages);
}

/**
 * The lifecycle change implied by an unhandled recommendation, or null when there is no domain
 * disagreement worth surfacing.
 */
export function recommendationDisagreement(
  recommendationValue: Recommendation | null,
  declined: Recommendation | null,
  lifecycle: RecommendationLifecycle,
): RecommendationLifecycle | null {
  if (recommendationValue === null || recommendationValue === "continue") return null;
  if (declined === recommendationValue) return null;
  if (lifecycle === "parked" || lifecycle === "completed" || lifecycle === "archived") return null;
  return recommendationValue === "complete" ? "completed" : "archived";
}

/**
 * Every enrichment in the catalogue, keyed by session id and by resume alias.
 *
 * This optional feature remains fail-open: an old schema or failed query yields no enrichments and
 * never hides lifecycle data owned by the full catalogue reader.
 */
export function readEnrichments(db: Database): Map<string, StoredEnrichment> {
  const found = new Map<string, StoredEnrichment>();
  try {
    const columns = new Set(
      (db.query("PRAGMA table_info(catalogue)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    const present = ["enrichment_state", "enrichment_summary"].filter((name) => columns.has(name));
    if (present.length === 0) return found;

    const where = present
      .map((column) => `(${column} IS NOT NULL AND TRIM(${column}) != '')`)
      .join(" OR ");
    const selected = OPTIONAL_ENRICHMENT_COLUMNS
      .map((name) => (columns.has(name) ? name : `NULL AS ${name}`))
      .join(",\n              ");
    const rows = db.query(
      `SELECT session_id, resume_id,
              ${selected}
         FROM catalogue
        WHERE ${where}`,
    ).all() as Array<Record<string, unknown>>;

    for (const row of rows) {
      const record = hydrateStoredEnrichment(row);
      if (record.state === null) continue;
      const sessionId = typeof row.session_id === "string" ? row.session_id : null;
      if (sessionId === null) continue;
      found.set(sessionId, record);
      const resumeId = typeof row.resume_id === "string" ? row.resume_id : null;
      if (resumeId) found.set(resumeId, record);
    }
  } catch {
    // Enrichment is optional here; lifecycle ownership stays with the caller's catalogue adapter.
  }
  return found;
}
