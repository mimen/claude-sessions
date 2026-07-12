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

/** The work-unit key a spawn targets (PR wins over gus-work), or null if neither is given.
 * TODO(ADR-0057): this is one of the 6 derived-string copies. The canonical path is now
 * `resolveWorkUnit()` in resolve-work-unit.ts, which returns the stable work-unit id (not
 * a derived string). This function stays for migration safety; callers will move to the
 * canonical resolver. */
export function spawnWorkUnit(f: SpawnFacts): string | null {
  if (f.prRepo && f.prNumber != null) return `pr:${f.prRepo}#${f.prNumber}`;
  if (f.gusWork) return `gus:${f.gusWork}`;
  return null;
}

/** The work-unit key for an existing catalogue row (same shape as spawnWorkUnit).
 * TODO(ADR-0057): this is one of the 6 derived-string copies. The canonical path is now
 * `resolveWorkUnit()` in resolve-work-unit.ts. This stays for migration safety. */
export function rowWorkUnit(row: CatalogueRow): string | null {
  if (row.prRepo && row.prNumber != null) return `pr:${row.prRepo}#${row.prNumber}`;
  if (row.gusWork) return `gus:${row.gusWork}`;
  return null;
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
 *  - one-embodiment (ADR-0032): refuse if a live session already owns this work-unit.
 *  - correct-worktree (ADR-0047): a worker with PR facts and a cwd must launch in a git
 *    worktree that is NOT on a protected branch (it can't build a PR on main). We can't verify
 *    the exact PR branch from number+repo alone, so we assert "on a feature branch," not "the
 *    right one" — an honest guard, not an over-claim.
 */
export function spawnContractError(
  facts: SpawnFacts,
  liveWorkUnits: ReadonlySet<string>,
  worktree: WorktreeState | null,
): string | null {
  const unit = spawnWorkUnit(facts);
  if (!unit) return null; // no work-unit → core role, contract N/A

  if (liveWorkUnits.has(unit)) {
    return `a live session already owns work-unit ${unit} (one responsibility, one embodiment — reuse it, don't spawn a second)`;
  }

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
