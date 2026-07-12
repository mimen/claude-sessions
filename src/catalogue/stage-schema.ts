import type { StageSchema } from "./db.ts";

/**
 * Pure validation of a stage transition against a role-declared schema (ADR-0064).
 *
 * The tool ENFORCES two guarantees the cluster DECLARES in role.toml (the ADR-0061 split):
 *  - vocabulary: the new value must be one of `schema.values` (if any are declared);
 *  - monotonic: when `schema.monotonic`, the stage may only move to an equal-or-higher rank
 *    (rank = index in `values`), so a flaky sensor can't drag `merged` back to `building`.
 *
 * Returns null when the transition is allowed, or a human-actionable error string when refused.
 * A null schema (role declares none) is unconstrained → always allowed.
 */
export function validateStageTransition(
  schema: StageSchema | null,
  current: string | null,
  next: string,
): string | null {
  if (!schema || schema.values.length === 0) return null; // unconstrained
  const nextRank = schema.values.indexOf(next);
  if (nextRank === -1) {
    return `stage "${next}" is not allowed (expected one of: ${schema.values.join(" | ")})`;
  }
  if (schema.monotonic && current) {
    const curRank = schema.values.indexOf(current);
    // A current value that isn't in the vocabulary can't be ranked — don't block on it (the
    // vocabulary may have changed under an old row); only enforce backward-motion between known ranks.
    if (curRank !== -1 && nextRank < curRank) {
      return `stage can't move ${current}→${next} (monotonic — forward only)`;
    }
  }
  return null;
}
