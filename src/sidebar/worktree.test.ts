import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { namesFrom, resolveCheckout } from "./worktree.ts";

describe("namesFrom", () => {
  test("names the repository when the directory is its main checkout", () => {
    expect(namesFrom("/repos/claude-sessions/.git", "/repos/claude-sessions", "main")).toEqual({
      project: "claude-sessions",
      worktree: null,
      branch: "main",
    });
  });

  test("keeps the project name and names the worktree separately in a linked worktree", () => {
    expect(namesFrom(
      "/repos/claude-sessions/.git",
      "/repos/claude-sessions/.claude/worktrees/sidebar-v2",
      "worktree-sidebar-v2",
    )).toEqual({
      project: "claude-sessions",
      worktree: "sidebar-v2",
      branch: "worktree-sidebar-v2",
    });
  });

  test("reads every worktree of one repository as the same project", () => {
    const first = namesFrom("/repos/app/.git", "/repos/app/.claude/worktrees/one", null);
    const second = namesFrom("/repos/app/.git", "/repos/app/.claude/worktrees/two", null);

    expect(first?.project).toBe("app");
    expect(second?.project).toBe("app");
    expect([first?.worktree, second?.worktree]).toEqual(["one", "two"]);
  });

  test("falls back to the checkout name when git cannot name the repository", () => {
    expect(namesFrom(null, "/somewhere/loose-checkout", "main")).toEqual({
      project: "loose-checkout",
      worktree: null,
      branch: "main",
    });
  });

  test("returns nothing when the directory is not in a checkout", () => {
    expect(namesFrom("/repos/app/.git", null, null)).toBeNull();
  });
});

describe("resolveCheckout", () => {
  test("distinguishes a linked worktree from its repository on a real checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-worktree-"));
    const repository = join(root, "sample-project");
    const linked = join(root, "linked-checkout");
    try {
      mkdirSync(repository, { recursive: true });
      const git = (cwd: string, args: string[]): void => {
        execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
      };
      git(repository, ["init", "--initial-branch=main"]);
      git(repository, ["config", "user.email", "test@example.com"]);
      git(repository, ["config", "user.name", "Test"]);
      git(repository, ["commit", "--allow-empty", "-m", "root"]);
      git(repository, ["worktree", "add", "-b", "side", linked]);

      await expect(resolveCheckout(repository)).resolves.toMatchObject({
        project: "sample-project",
        worktree: null,
      });
      await expect(resolveCheckout(linked)).resolves.toMatchObject({
        project: "sample-project",
        worktree: "linked-checkout",
        branch: "side",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null outside a repository", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-no-repo-"));
    try {
      await expect(resolveCheckout(directory)).resolves.toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
