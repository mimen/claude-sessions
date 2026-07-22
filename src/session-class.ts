/**
 * Sessions created before this contract remain visible without a speculative warning. New plain
 * Claude sessions observed on or after this instant are visible but explicitly unclassified.
 */
export const SESSION_CLASS_ROLLOUT_AT = "2026-07-20T00:00:00.000Z";
export const SESSION_CLASS_ROLLOUT_MS = Date.parse(SESSION_CLASS_ROLLOUT_AT);

/** Live root deployment of creator/launch provenance. Earlier sessions are not retroactively judged. */
export const SESSION_PROVENANCE_ROLLOUT_AT = "2026-07-22T19:25:38.000Z";
export const SESSION_PROVENANCE_ROLLOUT_MS = Date.parse(SESSION_PROVENANCE_ROLLOUT_AT);
