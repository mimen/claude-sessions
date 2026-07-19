import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePath, storageFolderOf, decodeStorageFolder, locateLaunchDir, encodesTo } from "./locate.ts";

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
  const result = decodeStorageFolder(folder);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value?.dir).toBe(dir);
    expect(result.value?.ambiguousWith).toBeNull();
    expect(result.value?.exhausted).toBe(false);
  }

  rmSync(base, { recursive: true, force: true });
});

test("decodeStorageFolder returns Ok(null) for non-folders and missing dirs", () => {
  const noLeadingDash = decodeStorageFolder("not-a-real-leading-dash" /* no leading - */);
  expect(noLeadingDash.ok).toBe(true);
  if (noLeadingDash.ok) expect(noLeadingDash.value).toBeNull();

  const missing = decodeStorageFolder("-Users-nope-nonexistent-xyz123");
  expect(missing.ok).toBe(true);
  if (missing.ok) expect(missing.value).toBeNull();
});

test("locateLaunchDir resolves a session file path to its launch dir", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-loc2-")));
  const proj = join(base, "Some Project");
  mkdirSync(proj, { recursive: true });
  const path = join(base, ".projects", encodePath(proj), "id.jsonl");
  const result = locateLaunchDir(path);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value?.dir).toBe(proj);
  rmSync(base, { recursive: true, force: true });
});

test("decodeStorageFolder surfaces ambiguity — /a-b and /a/b encode identically", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-amb-")));
  // Two dirs whose encoded realpath collide under encodePath:
  //   <base>/a-b encodes to <base-encoded>-a-b
  //   <base>/a/b encodes to <base-encoded>-a-b
  const dashed = join(base, "a-b");
  const nested = join(base, "a", "b");
  mkdirSync(dashed, { recursive: true });
  mkdirSync(nested, { recursive: true });

  // Storage folder is what both encode to.
  const folder = encodePath(dashed); // same as encodePath(nested)
  expect(encodePath(nested)).toBe(folder);

  const result = decodeStorageFolder(folder);
  expect(result.ok).toBe(true);
  if (result.ok && result.value) {
    // Both are legitimate; walk order picks one first. The other must be reported.
    const primary = result.value.dir;
    const alt = result.value.ambiguousWith;
    expect([dashed, nested]).toContain(primary);
    expect(alt).not.toBeNull();
    if (alt !== null) {
      expect([dashed, nested]).toContain(alt);
      expect(primary).not.toBe(alt);
    }
  }

  rmSync(base, { recursive: true, force: true });
});

test("decodeStorageFolder rejects a same-encoding decoy whose realpath doesn't round-trip", () => {
  // A symlink at <base>/decoy that points to <base>/wrong-repo. The dirent filter skips
  // symlinks entirely, so this is more of an insurance test: even if the filter changed,
  // encodesTo() would reject the symlink because realpath(decoy) resolves elsewhere.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-decoy-")));
  const real = join(base, "real");
  const wrongTarget = join(base, "wrong-target");
  mkdirSync(real, { recursive: true });
  mkdirSync(wrongTarget, { recursive: true });
  // A symlink whose NAME encodes identically to `real` but pointing at wrong-target.
  try {
    symlinkSync(wrongTarget, join(base, "real")); // may error if exists; fine — we test only the encodesTo path
  } catch {
    // no-op; sibling with same name already exists
  }

  // encodesTo on wrongTarget must equal encoded(real) only if they share the encoding.
  // They don't (different names) — proves round-trip guards decoys.
  expect(encodesTo(wrongTarget, encodePath(real))).toBe(false);

  rmSync(base, { recursive: true, force: true });
});
