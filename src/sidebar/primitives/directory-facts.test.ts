import { describe, expect, test } from "bun:test";
import { createDirectoryFactsPrimitive } from "./directory-facts.ts";
import type { DirectoryFactsResult } from "../directory-facts.ts";

function result(overrides: {
  checkouts?: Array<[string, { project: string; worktree: string | null; branch: string | null }]>;
  favicons?: Array<[string, string]>;
} = {}): DirectoryFactsResult {
  return {
    checkouts: new Map(overrides.checkouts ?? []),
    favicons: new Map(overrides.favicons ?? []),
  };
}

describe("createDirectoryFactsPrimitive", () => {
  test("resolves facts and assigns the first revision", async () => {
    const reader = createDirectoryFactsPrimitive({
      lookup: async () => result({ checkouts: [["/repo", { project: "r", worktree: null, branch: "main" }]] }),
    });
    const read = await reader.read(["/repo"]);
    expect(read.checkouts.get("/repo")?.project).toBe("r");
    expect(read.revision).toBe(1);
  });

  test("identical facts keep the revision stable", async () => {
    let worktree: string | null = null;
    const reader = createDirectoryFactsPrimitive({
      lookup: async () => result({
        checkouts: [["/repo", { project: "r", worktree, branch: "main" }]],
      }),
    });
    const a = await reader.read(["/repo"]);
    const b = await reader.read(["/repo"]);
    expect(b.revision).toBe(a.revision);
    worktree = "wt";
    const c = await reader.read(["/repo"]);
    expect(c.revision).toBe(a.revision + 1);
    expect(c.checkouts.get("/repo")?.worktree).toBe("wt");
  });

  test("a favicon change alone is a change", async () => {
    let icon: string | null = null;
    const reader = createDirectoryFactsPrimitive({
      lookup: async () => result({
        checkouts: [["/repo", { project: "r", worktree: null, branch: null }]],
        favicons: icon ? [["/repo", icon]] : [],
      }),
    });
    const a = await reader.read(["/repo"]);
    icon = "/repo/favicon.png";
    const b = await reader.read(["/repo"]);
    expect(b.revision).toBe(a.revision + 1);
  });

  test("a directory that stops resolving drops out and bumps the revision", async () => {
    let alive = true;
    const reader = createDirectoryFactsPrimitive({
      lookup: async (dirs) => result({
        checkouts: alive ? [["/repo", { project: "r", worktree: null, branch: null }]] : [],
      }),
    });
    void alive;
    const a = await reader.read(["/repo"]);
    expect(a.checkouts.size).toBe(1);
    alive = false;
    const b = await reader.read(["/repo"]);
    expect(b.checkouts.size).toBe(0);
    expect(b.revision).toBe(a.revision + 1);
  });
});
