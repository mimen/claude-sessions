import type { CatalogueRow } from "./db.ts";

/**
 * spawn-location resolution (ADR-0046): a role's launch cwd is config, not hardcoded. Because
 * spawn-location fires at new-session — BEFORE a session_id/row exists — it resolves from the
 * LAUNCH REQUEST (role/cluster/work-unit facts), not the row-keyed resolver. The caller builds a
 * synthetic row from the launch opts, resolves the `spawn-location` config (most-specific-wins),
 * and this pure interpreter maps it to a concrete cwd.
 *
 * Config shape: `{ "location": "role-dir" | "worktree" | "<absolute-path>" }`.
 *  - "role-dir"  → the role's registered home_dir (loops, designer — no repo context needed).
 *  - "worktree"  → the per-work-unit worktree the caller passed as --cwd (pr-agent; ADR-0046
 *                  frees this — CLAUDE.md is a hook, so cwd can be the worktree for repo context).
 *  - an absolute path → used verbatim (an escape hatch).
 * No config → null (caller falls back to the existing home_dir default; backward-compatible).
 */

export interface SpawnLocationConfig {
  location?: string;
}

export interface SpawnLocationInputs {
  /** The role's registered home_dir (for "role-dir"). */
  homeDir: string | null;
  /** The explicit --cwd the caller passed (the worktree, for "worktree"). */
  requestedCwd: string | null;
}

/**
 * Interpret a resolved spawn-location config into a cwd, or null if it can't (caller falls back).
 * Pure. Returns { cwd } on success, or { error } when the config names a mode whose input is
 * missing (e.g. "worktree" but no --cwd was passed) — a determinism failure the caller surfaces.
 */
export function interpretSpawnLocation(
  config: SpawnLocationConfig | null,
  inputs: SpawnLocationInputs,
): { cwd: string | null; error?: string } {
  const loc = config?.location;
  if (!loc) return { cwd: null }; // no config → caller uses its default

  if (loc === "role-dir") {
    if (!inputs.homeDir) return { cwd: null, error: `spawn-location "role-dir" but the role has no home_dir` };
    return { cwd: inputs.homeDir };
  }
  if (loc === "worktree") {
    if (!inputs.requestedCwd) return { cwd: null, error: `spawn-location "worktree" but no --cwd (worktree path) was given` };
    return { cwd: inputs.requestedCwd };
  }
  if (loc.startsWith("/")) return { cwd: loc }; // explicit absolute path
  return { cwd: null, error: `spawn-location "${loc}" is not a known mode (role-dir | worktree | /abs/path)` };
}

/** Build a synthetic row from launch facts so the row-keyed resolver can resolve pre-row config. */
export function syntheticRow(facts: {
  system?: string; role?: string; epicId?: string;
  prNumber?: number; prRepo?: string; gusWork?: string;
}): CatalogueRow {
  return {
    sessionId: "", resumeId: null, customTitle: null, kind: "session", completed: false,
    archived: false, parkedTaskId: null, key: null, parentSessionId: null,
    role: facts.role ?? null, resumeCommand: null, project: null,
    system: facts.system ?? null, gusWork: facts.gusWork ?? null, workUnitId: null, epicId: facts.epicId ?? null,
    statusLine: null, meta: {}, stage: null, activity: null, notes: null, updatedAt: null, prNumber: facts.prNumber ?? null,
    prRepo: facts.prRepo ?? null, prBranch: null, prState: null, prHeadSha: null,
  };
}
