/**
 * Resolving a directory to the checkout it belongs to.
 *
 * A row answers two different questions with two different lines. The top says *which project*
 * this is, and that must stay the same word whether the session runs in the main checkout or in
 * a linked worktree of it — otherwise ten worktrees of one repository read as ten projects. The
 * bottom says *which checkout*, and only earns its space when that is not the main one.
 *
 * `git rev-parse --git-common-dir` is what makes this cheap: every worktree of a repository
 * shares one common directory, so its parent is the main checkout, in a single call.
 */
import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";

const GIT_TIMEOUT_MS = 3_000;
const CHECKOUT_CONCURRENCY = 6;

export interface CheckoutInput {
  /** The repository's own name, identical across all of its worktrees. */
  readonly project: string;
  /** The linked worktree's name, or null when this is the repository's main checkout. */
  readonly worktree: string | null;
  readonly branch: string | null;
}

function runGit(directory: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", directory, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      resolve(error === null && typeof stdout === "string" ? stdout.trim() : null);
    });
  });
}

/**
 * Decide the project and worktree names from git's answers.
 *
 * Pure, so the naming rules are testable without a repository on disk. `commonDir` is the
 * shared `.git` directory (`…/repo/.git`, or `…/repo/.git/worktrees/<name>`'s common parent);
 * `topLevel` is the checkout the directory actually sits in.
 */
export function namesFrom(
  commonDir: string | null,
  topLevel: string | null,
  branch: string | null,
): CheckoutInput | null {
  if (!topLevel) return null;

  const checkout = basename(topLevel);
  if (!checkout) return null;

  // A bare or unusual layout leaves the project unknowable; the checkout is then all we can
  // truthfully say, so it takes the project line and the worktree line stays empty.
  if (!commonDir) return { project: checkout, worktree: null, branch };

  const mainCheckout = basename(dirname(commonDir));
  if (!mainCheckout) return { project: checkout, worktree: null, branch };

  return mainCheckout === checkout
    ? { project: mainCheckout, worktree: null, branch }
    : { project: mainCheckout, worktree: checkout, branch };
}

/** The checkout for one directory, or null when it is not inside a git repository. */
export async function resolveCheckout(directory: string): Promise<CheckoutInput | null> {
  const [commonDir, topLevel, branch] = await Promise.all([
    runGit(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    runGit(directory, ["rev-parse", "--show-toplevel"]),
    runGit(directory, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  return namesFrom(
    commonDir || null,
    topLevel || null,
    branch && branch !== "HEAD" ? branch : null,
  );
}

/** Resolve several directories with bounded concurrency; unresolvable ones are omitted. */
export async function resolveCheckouts(
  directories: readonly string[],
): Promise<Map<string, CheckoutInput>> {
  const resolved = new Map<string, CheckoutInput>();
  const queue = [...new Set(directories)];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const directory = queue[cursor];
      cursor += 1;
      if (!directory) continue;
      const checkout = await resolveCheckout(directory);
      if (checkout) resolved.set(directory, checkout);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(CHECKOUT_CONCURRENCY, queue.length) },
    () => worker(),
  ));
  return resolved;
}
