import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveProject, clearProjectCache } from "./project.ts";

afterEach(() => clearProjectCache());

test("null cwd is (unknown)", () => {
  expect(deriveProject(null)).toEqual({ root: "(unknown)", name: "(unknown)" });
});

test("nonexistent path falls back to itself", () => {
  const p = deriveProject("/no/such/path/sub");
  expect(p.root).toBe("/no/such/path/sub");
  expect(p.name).toBe("sub");
});

test("subdir of a repo resolves to the repo root", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-proj-"));
  const repo = join(base, "myrepo");
  const sub = join(repo, "app", "src");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(sub, { recursive: true });

  const fromRoot = deriveProject(repo);
  const fromSub = deriveProject(sub);
  rmSync(base, { recursive: true, force: true });

  expect(fromRoot.root).toBe(repo);
  expect(fromRoot.name).toBe("myrepo");
  // Subdir collapses to the same Project as the root.
  expect(fromSub.root).toBe(repo);
  expect(fromSub.name).toBe("myrepo");
});

test("non-repo existing dir falls back to itself", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-proj-"));
  const p = deriveProject(base);
  const name = base.slice(base.lastIndexOf("/") + 1);
  rmSync(base, { recursive: true, force: true });
  expect(p.root).toBe(base);
  expect(p.name).toBe(name);
});
