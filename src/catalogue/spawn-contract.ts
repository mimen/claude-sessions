import type { CatalogueRow } from "./db.ts";

/**
 * The worker spawn contract (ADR-0047): a fleet worker is born CORRECT or not at all. These are
 * PURE predicates over already-gathered facts (live work-units, the worktree's git branch), so
 * `new-session` can fail LOUD before minting a mis-wired worker. The impure gathering (liveness
 * probe, git read) lives in the caller; this is the tested decision layer.
 *
 * Scope: these apply to a WORKER spawn — one carrying PR/work-unit facts. Core roles (loops,
 * designer) carry no work-unit and skip the worktree/embodiment checks entirely.
 */

export interface SpawnFacts {
  /** Work-item id (W-number), if given at spawn. */
  gusWork?: string;
  prNumber?: number;
  prRepo?: string;
  /** The cwd the worker will launch in (its worktree, for a fleet worker). */
  cwd?: string;
}

/** The minimal anchor fields a work-unit key is derived from (row or spawn facts). */
export interface WorkUnitAnchor {
  prRepo?: string | null;
  prNumber?: number | null;
  gusWork?: string | null;
}

// --- the ONE canonical work-unit key derivation (ADR-0057/U4) ---------------------
// Every work-unit key in the codebase derives from HERE. Both the join key (stable, never
// sanitized) and the path key (filesystem-safe) come from one place, consistently.

const PATH_UNSAFE = /[^a-zA-Z0-9_.-]+/g;
/** Sanitize one path component (mirrors inbox/identity-path.seg): no separators/traversal. */
function seg(s: string): string {
  const cleaned = s.replace(/[/\\]/g, "-").replace(/\.\.+/g, "-").replace(PATH_UNSAFE, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

/** The canonical JOIN/DEDUP key: `pr:repo#num` | `gus:W-…` | null. Used for one-embodiment,
 * supersede-dedup, lineage — anywhere two things must recognize the SAME work-unit. Stable
 * and joinable (never sanitized), so `heroku/dashboard#12` matches everywhere. */
export function workUnitKey(a: WorkUnitAnchor): string | null {
  if (a.prRepo && a.prNumber != null) return `pr:${a.prRepo}#${a.prNumber}`;
  if (a.gusWork) return `gus:${a.gusWork}`;
  return null;
}

/** The canonical FILESYSTEM-SAFE work-unit key: `repo-num` (seg'd) | `W-…` (seg'd) | null.
 * Used ONLY for directory names (hook levels, identity/inbox dirs). Distinct from the join
 * key because path components can't contain `/` or `#`. One seg policy for BOTH dir uses,
 * fixing the drift where the level dir and inbox dir disagreed. */
export function workUnitPath(a: WorkUnitAnchor): string | null {
  if (a.prRepo && a.prNumber != null) return `${seg(a.prRepo)}-${a.prNumber}`;
  if (a.gusWork) return seg(a.gusWork);
  return null;
}

/** The work-unit key a spawn targets (PR wins over gus-work), or null if neither is given. */
export function spawnWorkUnit(f: SpawnFacts): string | null {
  return workUnitKey(f);
}

/** The work-unit key for an existing catalogue row — the canonical join/dedup key. */
export function rowWorkUnit(row: CatalogueRow): string | null {
  return workUnitKey(row);
}

/** Facts about the worktree the caller probed (git), passed to the branch check. */
export interface WorktreeState {
  /** Is `cwd` inside a git work-tree at all? */
  isGitWorktree: boolean;
  /** The checked-out branch (or null if detached HEAD / unknown). */
  branch: string | null;
}

/** Branches a worker must never operate a PR on — a PR lives on a feature branch. */
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

/**
 * The born-correct checks for a spawn. Returns an error string (caller errors out) or null.
 *
 *  - correct-worktree (ADR-0047): a worker with PR facts and a cwd must launch in a git
 *    worktree that is NOT on a protected branch (it can't build a PR on main). We can't verify
 *    the exact PR branch from number+repo alone, so we assert "on a feature branch," not "the
 *    right one" — an honest guard, not an over-claim.
 *
 * NOTE (ADR-0073): the one-embodiment REFUSAL was removed. A second embodiment of a work-unit is
 * no longer a spawn error — it's a tolerated, self-healing state: resume prefers the most-recently-
 * used session (MRU) and warns on live duplicates, and the atomic inbox drain (ADR-0033) makes a
 * transient twin harmless. Only born-WRONG configuration (bad worktree) is a hard error now.
 */
export function spawnContractError(
  facts: SpawnFacts,
  worktree: WorktreeState | null,
): string | null {
  const unit = spawnWorkUnit(facts);
  if (!unit) return null; // no work-unit → core role, contract N/A

  // Worktree check only when a cwd is given AND this is a PR worker (a git worktree is expected).
  if (facts.cwd && facts.prNumber != null && worktree) {
    if (!worktree.isGitWorktree) {
      return `cwd is not a git worktree: ${facts.cwd} (a pr-agent must launch in its PR's worktree)`;
    }
    if (worktree.branch && PROTECTED_BRANCHES.has(worktree.branch)) {
      return `worktree ${facts.cwd} is on protected branch "${worktree.branch}" — a worker must be on the PR's feature branch, not ${worktree.branch}`;
    }
  }
  return null;
}
