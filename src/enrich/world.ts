import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What is true about the world a session described, at the moment someone reads it.
 *
 * Enrichment's v39 defect was that it read only the transcript and never the world the transcript
 * describes. A transcript that stops mid-sentence is what EVERY abandoned session looks like, so
 * `continue` came to mean "this didn't end tidily" rather than "this is live" — 219 of 468
 * verdicts, and of the 79 on a feature branch, 61 pointed at work that had already landed or
 * vanished. None of that is knowable from the conversation; all of it is knowable from the repo.
 *
 * Two consumers, deliberately:
 *   - the PROMPT, so the model's verdict is honest when it is written; and
 *   - the DOSSIER, which recomputes at render time, because world state changes while a session
 *     sits still (you merge a branch; the session gains no messages; no freshness rule fires) and
 *     a stored world verdict would therefore rot silently.
 *
 * NO PROCESS SPAWN. `provenance.test.ts` forbids it across this directory, and while its stated
 * target is harness binaries that mint sessions, the rule as written is absolute and this module
 * respects it. That constraint is load-bearing on what this module can know — see below.
 */

/**
 * What git facts are and are not obtainable without running git.
 *
 * READABLE as plain files, and implemented here:
 *   - whether the cwd still exists;
 *   - whether it is a git repository at all;
 *   - the branch HEAD currently points at;
 *   - whether a named branch still exists (a loose ref file, or an entry in `packed-refs`).
 *
 * NOT READABLE without git, and deliberately absent:
 *   - whether a branch was MERGED into the default branch. That is a commit-graph ancestry
 *     question; answering it means decompressing commit objects and walking parents, and those
 *     objects may live inside packfiles. It is a real implementation, not a file read.
 *   - whether a worktree is DIRTY. That is an index-vs-worktree diff: stat data plus blob hashing
 *     for anything whose stat changed.
 *
 * The cost of the omission is small and measured. Of the 61 stale `continue` verdicts found on
 * feature branches, 54 were "branch deleted" — which IS readable here — and only 5 were "merged".
 * So this module recovers about 89% of the signal that motivated it, with no subprocess.
 */

export interface GitWorld {
  readonly kind: "git";
  /** Branch HEAD points at, or null when detached. */
  readonly headBranch: string | null;
  /** Whether the branch the session ran on still exists. Null when the session recorded none. */
  readonly sessionBranchExists: boolean | null;
}

export interface NoGitWorld {
  readonly kind: "no-git";
}

/** The cwd is gone, or unreadable. On its own a strong signal that the work is not resumable. */
export interface MissingWorld {
  readonly kind: "missing-cwd";
}

export type RepoWorld = GitWorld | NoGitWorld | MissingWorld;

export interface WorldState {
  readonly cwd: string | null;
  readonly repo: RepoWorld;
  /**
   * Top-level sessions that ran in this same directory and ended AFTER this one did.
   *
   * The signal that carries the coverage. The git checks say nothing for the third of the store
   * that is not in a repository — vault work, the home directory, ad-hoc directories — and nothing
   * useful for the half that sits on master/main. This works identically everywhere, costs one
   * index query, and while it does not prove the work landed, "14 sessions have worked here since"
   * is decisive about whether a description is still current.
   */
  readonly sessionsSince: number;
  /** ISO timestamp of the most recent of those, for a human-readable "most recent: 2 days ago". */
  readonly mostRecentSince: string | null;
}

/** Resolve `<cwd>/.git` to the directory holding refs, following a Gitfile if there is one. */
function resolveGitDir(cwd: string): string | null {
  const dotGit = join(cwd, ".git");
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return null;
  // A linked worktree or submodule: `.git` is a file reading `gitdir: <path>`. Its refs live in
  // the common dir, not here, so follow the pointer and then the commondir hop below.
  let pointer: string;
  try {
    pointer = readFileSync(dotGit, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return null;
  const target = match[1]!.trim();
  const resolved = target.startsWith("/") ? target : join(cwd, target);
  if (!existsSync(resolved)) return null;
  // Linked worktrees keep per-worktree HEAD here but share refs/ via `commondir`.
  const commonFile = join(resolved, "commondir");
  if (existsSync(commonFile)) {
    try {
      const common = readFileSync(commonFile, "utf8").trim();
      const commonPath = common.startsWith("/") ? common : join(resolved, common);
      if (existsSync(commonPath)) return commonPath;
    } catch {
      // Fall through to the worktree's own gitdir: HEAD is still readable there, and a missing
      // commondir costs us only the ref-existence check, which degrades to "unknown".
    }
  }
  return resolved;
}

/** The branch HEAD points at, or null when detached or unreadable. */
function readHeadBranch(gitDir: string): string | null {
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return match ? match[1]!.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Whether `refs/heads/<branch>` resolves, checking both storage forms.
 *
 * Git keeps refs either as one file per ref or packed into a single `packed-refs` after gc, and a
 * branch that exists in the packed form has no loose file at all — checking only the former would
 * report long-lived branches as deleted, which is precisely the verdict this feeds.
 */
function branchExists(gitDir: string, branch: string): boolean {
  if (existsSync(join(gitDir, "refs", "heads", branch))) return true;
  try {
    const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
    const needle = ` refs/heads/${branch}`;
    return packed.split("\n").some((line) => !line.startsWith("#") && line.endsWith(needle));
  } catch {
    return false;
  }
}

function readRepoWorld(cwd: string | null, sessionBranch: string | null): RepoWorld {
  if (!cwd || !existsSync(cwd)) return { kind: "missing-cwd" };
  const gitDir = resolveGitDir(cwd);
  if (!gitDir) return { kind: "no-git" };
  return {
    kind: "git",
    headBranch: readHeadBranch(gitDir),
    sessionBranchExists: sessionBranch ? branchExists(gitDir, sessionBranch) : null,
  };
}

/**
 * Later top-level sessions in the same directory.
 *
 * Subagents are excluded for the same reason the enrich candidate list excludes them: a sidechain
 * is not a separate body of work, so counting them would inflate every busy session's "someone
 * worked here since" into noise.
 */
function readSessionsSince(
  index: Database,
  sessionId: string,
  cwd: string | null,
  lastTs: string | null,
  exclude: ReadonlySet<string>,
): { count: number; mostRecent: string | null } {
  if (!cwd || !lastTs) return { count: 0, mostRecent: null };
  // Excluded ids are interpolated rather than bound because the count is variable and bun:sqlite
  // has no array binding. They are catalogue session ids (UUIDs) that never reach here from user
  // input, and the quote-stripping keeps that true even if that ever changes.
  const excluded = [...exclude].map((id) => `'${id.replace(/'/g, "")}'`);
  const excludeClause = excluded.length > 0 ? `AND session_id NOT IN (${excluded.join(", ")})` : "";
  const row = index
    .query(
      `SELECT COUNT(*) AS n, MAX(last_ts) AS most_recent
         FROM sessions
        WHERE cwd = $cwd
          AND last_ts > $lastTs
          AND session_id <> $id
          AND is_subagent = 0
          ${excludeClause}`,
    )
    .get({ $cwd: cwd, $lastTs: lastTs, $id: sessionId }) as
    | { n: number; most_recent: string | null }
    | null;
  return { count: row?.n ?? 0, mostRecent: row?.most_recent ?? null };
}

export interface WorldQuery {
  readonly sessionId: string;
  readonly cwd: string | null;
  /** The branch the session recorded at parse time, if any. */
  readonly branch: string | null;
  readonly lastTs: string | null;
}

/**
 * Everything knowable about the world a session left behind, without running a subprocess.
 *
 * `exclude` carries the incognito set, because this reads the INDEX and the incognito flag lives in
 * the catalogue: the caller is the only party holding both. It defaults to empty so the existing
 * tests and any caller with nothing to hide are unaffected. The world block is composed into a
 * prompt sent to the gateway, so an incognito session must not contribute even its existence here.
 */
export function readWorldState(
  index: Database,
  query: WorldQuery,
  exclude: ReadonlySet<string> = new Set(),
): WorldState {
  const since = readSessionsSince(index, query.sessionId, query.cwd, query.lastTs, exclude);
  return {
    cwd: query.cwd,
    repo: readRepoWorld(query.cwd, query.branch),
    sessionsSince: since.count,
    mostRecentSince: since.mostRecent,
  };
}

/**
 * The `<world>` block as the model reads it.
 *
 * Facts only, one per line, no interpretation — the recommendation description in
 * `enrichment-schema.ts` is where they are turned into guidance. Anything unknown is omitted
 * rather than reported as false, because "branch: unknown" invites the model to guess and a
 * missing line does not.
 */
export function renderWorldBlock(world: WorldState): string {
  const lines: string[] = [];
  switch (world.repo.kind) {
    case "missing-cwd":
      lines.push("working directory: NO LONGER EXISTS");
      break;
    case "no-git":
      lines.push("working directory: exists (not a git repository)");
      break;
    case "git": {
      lines.push("working directory: exists");
      if (world.repo.sessionBranchExists === true) {
        lines.push("the branch this session ran on: still exists");
      } else if (world.repo.sessionBranchExists === false) {
        lines.push("the branch this session ran on: DELETED since");
      }
      if (world.repo.headBranch) lines.push(`branch checked out there now: ${world.repo.headBranch}`);
      break;
    }
  }
  lines.push(`later sessions in this directory: ${world.sessionsSince}`);
  if (world.mostRecentSince) lines.push(`most recent of those: ${world.mostRecentSince}`);
  return lines.join("\n");
}
