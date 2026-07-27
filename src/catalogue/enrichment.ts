/**
 * Enrichment summaries, read straight off the catalogue columns.
 *
 * This lives here rather than in either UI because both the sidebar and the TUI need the same
 * answer to "what did enrichment conclude, and how stale is it?" — and a summary that disagrees
 * between the two surfaces is worse than no summary at all.
 *
 * The catalogue row type does not carry these fields, so they are queried directly. Only ~a fifth
 * of sessions have ever been enriched, so a missing summary is the normal case and yields no entry
 * rather than an empty string every caller would have to special-case.
 */
import type { Database } from "bun:sqlite";

/** What enrichment concluded about a session, as the catalogue recorded it. */
export interface SessionEnrichment {
  /** What happened in the session. */
  readonly summary: string;
  /** Why the recommendation follows, in enrichment's own words. */
  readonly reason: string | null;
  /** What enrichment thinks should happen next. */
  readonly recommendation: string | null;
  /** Work explicitly left open. */
  readonly outstanding: string | null;
  /** Transcript message count when the summary was written. */
  readonly atMessages: number | null;
}

/**
 * How far the transcript has moved since a summary was written, or null when either count is
 * unknown.
 *
 * Messages rather than turns: the catalogue records a message count at enrichment time and never
 * recorded a turn count, so turns cannot be derived without inventing one. `enrichment_at_messages`
 * is measured against `msg_count`, the same counter it was stamped from — comparing it to
 * `user_turns` (20-30x smaller) would report every summary as wildly stale.
 */
export function messagesSince(
  enrichment: Pick<SessionEnrichment, "atMessages">,
  currentMessageCount: number | null | undefined,
): number | null {
  if (enrichment.atMessages === null) return null;
  if (currentMessageCount === null || currentMessageCount === undefined) return null;
  return Math.max(0, currentMessageCount - enrichment.atMessages);
}

/**
 * Every enrichment record in the catalogue, keyed by session id and by resume alias so a resumed
 * session finds the summary written under either identity.
 *
 * A catalogue predating any of these columns simply yields the fields it does have; one predating
 * `enrichment_summary` entirely yields nothing.
 */
export function readEnrichmentSummaries(db: Database): Map<string, SessionEnrichment> {
  const summaries = new Map<string, SessionEnrichment>();
  try {
    const columns = new Set(
      (db.query("PRAGMA table_info(catalogue)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has("enrichment_summary")) return summaries;
    // Each companion column is selected only when it exists, so a catalogue written before any one
    // of them was added still yields the fields it does have.
    const optional = (name: string): string =>
      columns.has(name) ? name : `NULL AS ${name}`;
    const rows = db.query(
      `SELECT session_id, resume_id, enrichment_summary,
              ${optional("enrichment_reason")},
              ${optional("enrichment_recommendation")},
              ${optional("enrichment_outstanding")},
              ${optional("enrichment_at_messages")}
         FROM catalogue
        WHERE enrichment_summary IS NOT NULL AND TRIM(enrichment_summary) != ''`,
    ).all() as Array<{
      session_id: string;
      resume_id: string | null;
      enrichment_summary: string;
      enrichment_reason: string | null;
      enrichment_recommendation: string | null;
      enrichment_outstanding: string | null;
      enrichment_at_messages: number | null;
    }>;
    const text = (value: string | null): string | null => {
      const trimmed = value?.trim() ?? "";
      return trimmed.length > 0 ? trimmed : null;
    };
    for (const row of rows) {
      const record: SessionEnrichment = {
        summary: row.enrichment_summary.trim(),
        reason: text(row.enrichment_reason),
        recommendation: text(row.enrichment_recommendation),
        outstanding: text(row.enrichment_outstanding),
        atMessages: row.enrichment_at_messages ?? null,
      };
      summaries.set(row.session_id, record);
      if (row.resume_id) summaries.set(row.resume_id, record);
    }
  } catch {
    // A summary is a nicety; failing to read one must never cost the caller its lifecycle data.
  }
  return summaries;
}
