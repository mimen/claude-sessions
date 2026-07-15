import { expect, test } from "bun:test";
import { spawnWorkUnit, rowWorkUnit, workUnitKey, workUnitPath, spawnContractError, type SpawnFacts, type WorktreeState } from "./spawn-contract.ts";
import { workUnitOf } from "../hooks/resolve-levels.ts";
import type { CatalogueRow } from "./db.ts";

const gitFeature: WorktreeState = { isGitWorktree: true, branch: "feature/fix-navbar" };

function row(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "s", resumeId: null, customTitle: null, kind: "session", completed: false,
    archived: false, parkedTaskId: null, key: null, parentSessionId: null,
    role: null, resumeCommand: null, project: null, cluster: null, gusWork: null, workUnitId: null,
    groupingId: null, statusLine: null, meta: {}, stage: null, notes: null, updatedAt: null, prNumber: null, prRepo: null,
    prBranch: null, prState: null, prHeadSha: null, identityKey: null, ...over,
  };
}

test("spawnWorkUnit: PR wins over gus-work; null when neither", () => {
  expect(spawnWorkUnit({ prRepo: "heroku/dashboard", prNumber: 12080, gusWork: "W-1" })).toBe("pr:heroku/dashboard#12080");
  expect(spawnWorkUnit({ gusWork: "W-23392849" })).toBe("gus:W-23392849");
  expect(spawnWorkUnit({})).toBeNull();
});

test("rowWorkUnit matches spawnWorkUnit shape", () => {
  expect(rowWorkUnit(row({ prRepo: "a/b", prNumber: 5 }))).toBe("pr:a/b#5");
  expect(rowWorkUnit(row({ gusWork: "W-9" }))).toBe("gus:W-9");
});

test("workUnitKey (join form) is stable + joinable; slash/# preserved", () => {
  expect(workUnitKey({ prRepo: "heroku/dashboard", prNumber: 12 })).toBe("pr:heroku/dashboard#12");
  expect(workUnitKey({ gusWork: "W-1" })).toBe("gus:W-1");
  expect(workUnitKey({})).toBeNull();
});

test("workUnitPath (fs form) segs consistently; NO slash/# in a path component", () => {
  const p = workUnitPath({ prRepo: "heroku/dashboard", prNumber: 12 });
  expect(p).toBe("heroku-dashboard-12");
  expect(p).not.toContain("/");
  expect(p).not.toContain("#");
});

test("DRIFT FIX (U4/P0): the hook-level dir key == the inbox dir key for a slash'd repo", () => {
  // resolve-levels.workUnitOf (hook-level dir) and the inbox responsibility key both now come
  // from workUnitPath — so a worker's config dir and its inbox dir resolve to the SAME name.
  const r = row({ prRepo: "heroku/dashboard", prNumber: 12080 });
  expect(workUnitOf(r)).toBe(workUnitPath(r)); // one source of truth
  expect(workUnitOf(r)).toBe("heroku-dashboard-12080");
});

test("core role (no work-unit) has no contract — always passes", () => {
  expect(spawnContractError({ cwd: "/roles/control" }, null)).toBeNull();
});

test("duplicate embodiment is ALLOWED (ADR-0073): a PR worker spawns even on a valid worktree", () => {
  // The one-embodiment REFUSAL is gone — a second session for the same work-unit is tolerated
  // (resume prefers the MRU session + warns; atomic drain keeps it harmless). Only worktree
  // correctness is gated now, so a well-formed spawn passes regardless of any live twin.
  const facts: SpawnFacts = { prRepo: "heroku/dashboard", prNumber: 12080, cwd: "/wt" };
  expect(spawnContractError(facts, gitFeature)).toBeNull();
});

test("correct-worktree: refuse a PR worker whose cwd isn't a git worktree", () => {
  const facts: SpawnFacts = { prRepo: "a/b", prNumber: 1, cwd: "/not/git" };
  expect(spawnContractError(facts, { isGitWorktree: false, branch: null })).toContain("not a git worktree");
});

test("correct-worktree: refuse a PR worker on a protected branch (main)", () => {
  const facts: SpawnFacts = { prRepo: "a/b", prNumber: 1, cwd: "/wt" };
  expect(spawnContractError(facts, { isGitWorktree: true, branch: "main" })).toContain("protected branch");
});

test("correct-worktree: a feature branch passes", () => {
  const facts: SpawnFacts = { prRepo: "a/b", prNumber: 1, cwd: "/wt" };
  expect(spawnContractError(facts, gitFeature)).toBeNull();
});

test("a W-only worker (no PR) skips the worktree/branch check", () => {
  // gus-work without a PR number → no git-worktree expectation (may be pre-PR work).
  const facts: SpawnFacts = { gusWork: "W-1", cwd: "/anywhere" };
  expect(spawnContractError(facts, null)).toBeNull();
});
