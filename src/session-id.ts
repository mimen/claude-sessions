/**
 * Short session-id resolution. A full Claude session id is a 36-char UUID; typing it in full is
 * painful, so every command that takes a `<session-id>` accepts a unique PREFIX of one instead
 * (e.g. `0ca6d244` for `0ca6d244-280e-4834-8db0-fc3573ab80da`).
 *
 * The resolver is a pure function over a candidate list so both resolution paths share one
 * implementation and one ambiguity policy:
 *   - the catalogue/index DBs (`ccs session <id>` and friends), and
 *   - the live cmux bridge (`locateSession`/`isOpen`, keyed by the hook-store session ids).
 *
 * Ambiguity FAILS CLOSED (never silently pick a candidate). This repo has a documented history of
 * resume runaways from trusting stale/ambiguous session bindings (ADR-0054, the 2026-07-10 fleet
 * resume runaway); a short id that matches more than one session must error and list the matches,
 * not guess.
 */
import type { Result } from "./result.ts";
import { ok, err } from "./result.ts";

export type ResolveIdError =
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly matches: readonly string[] };

/**
 * Resolve `input` against `candidates` (full session ids):
 *   - exact match wins immediately (full UUID fast path, and a short id that is itself complete),
 *   - else a unique prefix match resolves,
 *   - else `{kind:"none"}` (no prefix matched) or `{kind:"ambiguous", matches}` (>1 matched).
 *
 * Duplicate candidate ids collapse to one (a session can appear in both the catalogue and the
 * index) so a session listed twice is not mistaken for an ambiguous prefix.
 */
export function resolveIdPrefix(
  candidates: Iterable<string>,
  input: string,
): Result<string, ResolveIdError> {
  const all = new Set(candidates);
  if (all.has(input)) return ok(input);
  // An empty input is not a prefix of anything meaningful — it would match every candidate. Treat
  // it as no-match so callers like isOpen("") keep their prior false result instead of matching a
  // lone live session by accident.
  if (input === "") return err({ kind: "none" });

  const matches: string[] = [];
  for (const id of all) {
    if (id.startsWith(input)) matches.push(id);
  }
  if (matches.length === 1) return ok(matches[0]!);
  if (matches.length === 0) return err({ kind: "none" });
  return err({ kind: "ambiguous", matches: matches.sort() });
}

/** Human-readable one-liner for an ambiguous-prefix error (shared by the CLI callers). */
export function ambiguousMessage(input: string, matches: readonly string[]): string {
  return `ambiguous session id '${input}' matches ${matches.length} sessions: ${matches.join(", ")}`;
}
