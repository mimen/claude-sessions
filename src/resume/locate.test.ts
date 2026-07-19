import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePath, storageFolderOf, decodeStorageFolder, locateLaunchDir } from "./locate.ts";

function decoded(folder: string) {
  const result = decodeStorageFolder(folder);
  if (!result.ok) throw result.error;
  return result.value;
}

test("encodePath maps every non-alphanumeric to '-' without lowercasing", () => {
  expect(encodePath("/Users/you/Obsidian/My Vault")).toBe("-Users-you-Obsidian-My-Vault");
  expect(encodePath("/a/b-c/d")).toBe("-a-b-c-d");
});

test("storageFolderOf returns the parent dir name of a session file", () => {
  expect(storageFolderOf("/x/.claude/projects/-Users-me-repo/abc.jsonl")).toBe("-Users-me-repo");
});

test("decodeStorageFolder walks the filesystem back to the real dir (lossy-safe)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-dec-")));
  const dir = join(base, "Weird Name's Dir");
  mkdirSync(dir, { recursive: true });

  const located = decoded(encodePath(dir));
  expect(located?.dir).toBe(dir);
  expect(located?.ambiguousWith).toBeNull();

  rmSync(base, { recursive: true, force: true });
});

test("decodeStorageFolder returns Ok(null) for non-folders and missing dirs", () => {
  const noLeadingDash = decodeStorageFolder("not-a-real-leading-dash");
  expect(noLeadingDash.ok).toBe(true);
  if (noLeadingDash.ok) expect(noLeadingDash.value).toBeNull();

  const missing = decodeStorageFolder("-Users-nope-nonexistent-xyz123");
  expect(missing.ok).toBe(true);
  if (missing.ok) expect(missing.value).toBeNull();
});

test("the root dir itself decodes ('/' → '-')", () => {
  expect(decoded("-")?.dir).toBe("/");
});

test("a same-encoding symlink is not a candidate (dirent filter)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-sym-")));
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const decoy = join(base, "a b");
  symlinkSync(elsewhere, decoy);

  expect(decoded(encodePath(decoy))).toBeNull();

  rmSync(base, { recursive: true, force: true });
});

test("the real dir is found alongside a same-encoding symlink", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-sym2-")));
  mkdirSync(join(base, "zzz"), { recursive: true });
  const real = join(base, "a.b");
  mkdirSync(real, { recursive: true });
  symlinkSync(join(base, "zzz"), join(base, "a b"));

  expect(decoded(encodePath(real))?.dir).toBe(real);

  rmSync(base, { recursive: true, force: true });
});

test("ambiguous encodings are detected (ambiguousWith populated)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-amb-")));
  const flat = join(base, "x-y");
  const nested = join(base, "x", "y");
  mkdirSync(flat, { recursive: true });
  mkdirSync(nested, { recursive: true });

  const located = decoded(encodePath(flat));
  expect(located).not.toBeNull();
  if (located) {
    expect([flat, nested]).toContain(located.dir);
    expect(located.ambiguousWith).not.toBeNull();
    if (located.ambiguousWith) {
      expect([flat, nested]).toContain(located.ambiguousWith);
      expect(located.dir).not.toBe(located.ambiguousWith);
    }
  }

  rmSync(base, { recursive: true, force: true });
});

test("decodeStorageFolder stays depth-bounded on a real deep fixture tree", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-deep-")));
  let deep = base;
  for (let i = 0; i < 30; i++) deep = join(deep, `d${i}`);
  mkdirSync(deep, { recursive: true });

  const started = Date.now();
  expect(decoded(encodePath(deep))).toBeNull();
  expect(Date.now() - started).toBeLessThan(2000);

  rmSync(base, { recursive: true, force: true });
});

test("a bound hit after the first match reports exhausted (ambiguity not ruled out)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-exh-")));
  const segments = Array.from({ length: 30 }, (_, i) => `d${i}`);
  const flatTwin = join(base, segments.join("-"));
  mkdirSync(flatTwin, { recursive: true });
  mkdirSync(join(base, ...segments), { recursive: true });

  const located = decoded(encodePath(flatTwin));
  expect(located?.dir).toBe(flatTwin);
  expect(located?.ambiguousWith).toBeNull();
  expect(located?.exhausted).toBe(true);

  rmSync(base, { recursive: true, force: true });
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
