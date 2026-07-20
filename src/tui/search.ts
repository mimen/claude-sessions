import fuzzysort from "fuzzysort";
import type { SessionRow } from "../index/index.ts";

/**
 * Rank rows for a query: fuzzy name matches (title/project) first, ordered by match score,
 * then content-only matches (skeleton FTS hits not already matched by name), in recency
 * order. This is the relevance fix deferred from M2 — a title hit beats a body-only mention.
 * `contentIds` is the set of session ids whose skeleton matched the query (from FTS).
 */
export function searchRows(
  rows: readonly SessionRow[],
  query: string,
  contentIds: ReadonlySet<string>,
  /** Extra fuzzy haystack per session (e.g. Claude task subjects), joined into one string. */
  extraText?: ReadonlyMap<string, string>,
): SessionRow[] {
  const q = query.trim();
  if (!q) return [...rows];

  const results = fuzzysort.go(q, rows, {
    keys: ["title", "projectName", (r) => extraText?.get(r.sessionId) ?? ""],
    threshold: -10000,
  });

  const ordered: SessionRow[] = [];
  const matched = new Set<string>();
  for (const res of results) {
    ordered.push(res.obj);
    matched.add(res.obj.sessionId);
  }
  for (const row of rows) {
    if (contentIds.has(row.sessionId) && !matched.has(row.sessionId)) {
      ordered.push(row);
    }
  }
  return ordered;
}
