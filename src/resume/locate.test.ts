import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePath, storageFolderOf, decodeStorageFolder, locateLaunchDir } from "./locate.ts";

test("encodePath maps every non-alphanumeric to '-' without lowercasing", () => {
  expect(encodePath("/Users/you/Obsidian/My Vault")).toBe("-Users-you-Obsidian-My-Vault");
  expect(encodePath("/a/b-c/d")).toBe("-a-b-c-d");
});

test("storageFolderOf returns the parent dir name of a session file", () => {
  expect(storageFolderOf("/x/.claude/projects/-Users-me-repo/abc.jsonl")).toBe("-Users-me-repo");
});

test("decodeStorageFolder walks the filesystem back to the real dir (lossy-safe)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-dec-")));
  const dir = join(base, "Weird Name's Dir"); // spaces + apostrophe → multiple '-'
  mkdirSync(dir, { recursive: true });

  const folder = encodePath(dir);
  expect(decodeStorageFolder(folder)).toBe(dir);

  rmSync(base, { recursive: true, force: true });
});

test("decodeStorageFolder returns null for non-folders and missing dirs", () => {
  expect(decodeStorageFolder("not-a-real-leading-dash" /* no leading - */)).toBeNull();
  expect(decodeStorageFolder("-Users-nope-nonexistent-xyz123")).toBeNull();
});

test("locateLaunchDir resolves a session file path to its launch dir", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-loc2-")));
  const proj = join(base, "Some Project");
  mkdirSync(proj, { recursive: true });
  const path = join(base, ".projects", encodePath(proj), "id.jsonl");
  expect(locateLaunchDir(path)).toBe(proj);
  rmSync(base, { recursive: true, force: true });
});
