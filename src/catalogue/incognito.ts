import type { Database } from "bun:sqlite";
import type { CatalogueRow } from "./db-schema.ts";

/**
 * The one definition of "this session must not be surfaced".
 *
 * A shared helper rather than another inline `row?.incognito === true`, because the reason
 * incognito is expensive to add at all is that the codebase has no shared visibility predicate:
 * `archived` and `session_class === "auxiliary"` are each re-derived by hand at more than a dozen
 * call sites, and every one of them is a place the next attribute has to be threaded through
 * again. One import is greppable; fourteen literals are not.
 *
 * Unlike `archived` and `auxiliary`, this predicate is NEVER gated behind a caller flag. Those two
 * have `--all` / `--auxiliary` escape hatches because hiding them is a default, not a guarantee.
 * Incognito is a guarantee: no ccs surface reveals these sessions, so there is deliberately no
 * option to pass that turns the filter off.
 */
export function isIncognito(row: Pick<CatalogueRow, "incognito"> | null | undefined): boolean {
  return row?.incognito === true;
}

/**
 * SQL fragment excluding incognito rows, for queries that alias `catalogue` as `c`.
 *
 * `IS NOT 1` rather than `= 0` so a row predating the column (NULL, if a catalogue was written by
 * an older binary before the DEFAULT applied) reads as visible instead of vanishing.
 */
export const NOT_INCOGNITO_SQL = "c.incognito IS NOT 1";

/**
 * Every incognito session id, for callers that must filter the INDEX.
 *
 * The index and the catalogue are separate SQLite files and the flag lives only in the latter, so a
 * query over `sessions` cannot join to it. Callers holding both databases resolve the set here and
 * pass it down. Cheap by construction: the partial index on `incognito = 1` means this reads only
 * the handful of rows it returns.
 */
export function incognitoSessionIds(catalogue: Database): ReadonlySet<string> {
  const rows = catalogue
    .query("SELECT session_id AS sessionId FROM catalogue WHERE incognito = 1")
    .all() as Array<{ sessionId: string }>;
  return new Set(rows.map((row) => row.sessionId));
}
