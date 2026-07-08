import type { CatalogueRow, PrFacts, PrState } from "../catalogue/db.ts";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Pure fold: stamp PR facts onto a catalogue row without mutating identity.
 * The sessionId and event fields (identity keys) are never overwritten.
 */
export function foldPrFacts(row: CatalogueRow, sensedFacts: PrFacts | null): CatalogueRow {
  return {
    ...row,
    prNumber: sensedFacts?.prNumber ?? null,
    prRepo: sensedFacts?.prRepo ?? null,
    prBranch: sensedFacts?.prBranch ?? null,
    prState: sensedFacts?.prState ?? null,
    prHeadSha: sensedFacts?.prHeadSha ?? null,
  };
}

/**
 * Thin I/O shell: sense PR facts from a cwd using `gh` and `git`.
 * Returns null if the cwd is not a git repo or has no associated PR.
 */
export async function sensePrFacts(cwd: string | null): Promise<PrFacts | null> {
  if (!cwd) return null;

  // Check if the cwd exists and is a git repo
  if (!existsSync(cwd)) return null;

  // Check if this is a git repository by looking for .git
  let searchDir = cwd;
  let foundGitRoot = false;
  while (searchDir !== "/" && searchDir !== ".") {
    if (existsSync(`${searchDir}/.git`)) {
      foundGitRoot = true;
      break;
    }
    searchDir = dirname(searchDir);
  }
  if (!foundGitRoot) return null;

  try {
    // Get the current branch
    const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const branchOutput = await new Response(branchProc.stdout).text();
    await branchProc.exited;
    if (branchProc.exitCode !== 0) return null;

    const branch = branchOutput.trim();
    if (!branch || branch === "HEAD") return null; // detached HEAD

    // Get the HEAD SHA
    const shaProc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const shaOutput = await new Response(shaProc.stdout).text();
    await shaProc.exited;
    if (shaProc.exitCode !== 0) return null;

    const headSha = shaOutput.trim();
    if (!headSha) return null;

    // Use `gh pr view` to get PR info for this branch
    const ghProc = Bun.spawn(
      [
        "gh",
        "pr",
        "view",
        branch,
        "--json",
        "number,headRepositoryOwner,headRepository,state,headRefOid",
      ],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const ghOutput = await new Response(ghProc.stdout).text();
    await ghProc.exited;

    if (ghProc.exitCode !== 0 || !ghOutput.trim()) {
      // No PR for this branch
      return null;
    }

    const prData = JSON.parse(ghOutput) as {
      number: number;
      headRepositoryOwner: { login: string };
      headRepository: { name: string };
      state: string;
      headRefOid: string;
    };

    // Map GitHub PR state to our PrState type
    const state: PrState = prData.state === "MERGED" ? "merged" : prData.state === "OPEN" ? "open" : "closed";

    return {
      prNumber: prData.number,
      prRepo: `${prData.headRepositoryOwner.login}/${prData.headRepository.name}`,
      prBranch: branch,
      prState: state,
      prHeadSha: headSha,
    };
  } catch {
    // Any error (gh not installed, not authenticated, JSON parse failure) → no PR facts
    return null;
  }
}
