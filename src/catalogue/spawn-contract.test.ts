import { expect, test } from "bun:test";
import { spawnWorkUnit, rowWorkUnit, spawnContractError, type SpawnFacts, type WorktreeState } from "./spawn-contract.ts";
import type { CatalogueRow } from "./db.ts";

const NONE: ReadonlySet<string> = new Set();
const gitFeature: WorktreeState = { isGitWorktree: true, branch: "feature/fix-navbar" };

function row(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "s", resumeId: null, customTitle: null, kind: "session", completed: false,
    archived: false, parkedTaskId: null, event: null, key: null, parentSessionId: null,
    skill: null, role: null, resumeCommand: null, project: null, system: null, gusWork: null, workUnitId: null,
    epicId: null, phase: null, statusLine: null, miladReview: null, buildComplete: false, meta: {}, stage: null, activity: null, notes: null, updatedAt: null, prNumber: null, prRepo: null,
    prBranch: null, prState: null, prHeadSha: null, ...over,
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

test("core role (no work-unit) has no contract — always passes", () => {
  expect(spawnContractError({ cwd: "/roles/control" }, NONE, null)).toBeNull();
});

test("one-embodiment: refuse when a live session already owns the work-unit", () => {
  const facts: SpawnFacts = { prRepo: "heroku/dashboard", prNumber: 12080, cwd: "/wt", };
  const live = new Set(["pr:heroku/dashboard#12080"]);
  expect(spawnContractError(facts, live, gitFeature)).toContain("already owns");
});

test("one-embodiment: a DIFFERENT live work-unit doesn't block", () => {
  const facts: SpawnFacts = { prRepo: "heroku/dashboard", prNumber: 12080, cwd: "/wt" };
  const live = new Set(["pr:heroku/dashboard#99999"]);
  expect(spawnContractError(facts, live, gitFeature)).toBeNull();
});

test("correct-worktree: refuse a PR worker whose cwd isn't a git worktree", () => {
  const facts: SpawnFacts = { prRepo: "a/b", prNumber: 1, cwd: "/not/git" };
  expect(spawnContractError(facts, NONE, { isGitWorktree: false, branch: null })).toContain("not a git worktree");
});

test("correct-worktree: refuse a PR worker on a protected branch (main)", () => {
  const facts: SpawnFacts = { prRepo: "a/b", prNumber: 1, cwd: "/wt" };
  expect(spawnContractError(facts, NONE, { isGitWorktree: true, branch: "main" })).toContain("protected branch");
});

test("correct-worktree: a feature branch passes", () => {
  const facts: SpawnFacts = { prRepo: "a/b", prNumber: 1, cwd: "/wt" };
  expect(spawnContractError(facts, NONE, gitFeature)).toBeNull();
});

test("a W-only worker (no PR) skips the worktree/branch check", () => {
  // gus-work without a PR number → no git-worktree expectation (may be pre-PR work).
  const facts: SpawnFacts = { gusWork: "W-1", cwd: "/anywhere" };
  expect(spawnContractError(facts, NONE, null)).toBeNull();
});
