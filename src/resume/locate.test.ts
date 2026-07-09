import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from "node:fs";
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

  const located = decodeStorageFolder(encodePath(dir));
  expect(located?.dir).toBe(dir);
  expect(located?.ambiguousWith).toBeNull();

  rmSync(base, { recursive: true, force: true });
});

test("decodeStorageFolder returns null for non-folders and missing dirs", () => {
  expect(decodeStorageFolder("not-a-real-leading-dash" /* no leading - */)).toBeNull();
  expect(decodeStorageFolder("-Users-nope-nonexistent-xyz123")).toBeNull();
});

test("the root dir itself decodes ('/' → '-')", () => {
  expect(decodeStorageFolder("-")?.dir).toBe("/");
});

// A same-encoding symlink never becomes a candidate: the walk's dirent filter skips symlinks
// (isDirectory() is false for a symlink-to-dir), and claude's getcwd is symlink-resolved so no
// session is ever stored under a symlink path. encodesTo() backstops this should either change.
test("a same-encoding symlink is not a candidate (dirent filter)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-sym-")));
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const decoy = join(base, "a b"); // encodes like `a.b` would
  symlinkSync(elsewhere, decoy);

  expect(decodeStorageFolder(encodePath(decoy))).toBeNull(); // nothing real matches

  rmSync(base, { recursive: true, force: true });
});

test("the real dir is found alongside a same-encoding symlink", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-sym2-")));
  mkdirSync(join(base, "zzz"), { recursive: true });
  const real = join(base, "a.b");
  mkdirSync(real, { recursive: true });
  symlinkSync(join(base, "zzz"), join(base, "a b")); // same encoding as a.b

  expect(decodeStorageFolder(encodePath(real))?.dir).toBe(real);

  rmSync(base, { recursive: true, force: true });
});

// TWO real dirs with the same encoding = genuine ambiguity; the walk keeps going after the
// first hit so the caller can SAY so instead of silently trusting readdir order.
test("ambiguous encodings are detected (ambiguousWith populated)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-amb-")));
  const flat = join(base, "x-y");
  const nested = join(base, "x", "y");
  mkdirSync(flat, { recursive: true });
  mkdirSync(nested, { recursive: true });

  const located = decodeStorageFolder(encodePath(flat))!; // === encodePath(nested)
  expect([flat, nested]).toContain(located.dir);
  expect([flat, nested]).toContain(located.ambiguousWith!);
  expect(located.dir).not.toBe(located.ambiguousWith);

  rmSync(base, { recursive: true, force: true });
});

// The DEPTH bound holds against a real tree deeper than the walk allows: the walk gives up
// (null) instead of descending forever. The recorded-cwd fast path still resumes such sessions.
test("decodeStorageFolder stays depth-bounded on a real deep fixture tree", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-deep-")));
  let deep = base;
  for (let i = 0; i < 30; i++) deep = join(deep, `d${i}`); // 30 levels under tmp > MAX_DEPTH total
  mkdirSync(deep, { recursive: true });

  const started = Date.now();
  expect(decodeStorageFolder(encodePath(deep))).toBeNull(); // bound hit, not found
  expect(Date.now() - started).toBeLessThan(2000); // and it gave up fast

  rmSync(base, { recursive: true, force: true });
});

// One match found but the bounded search gave up elsewhere: `exhausted` says ambiguity was NOT
// ruled out. Fixture: a flat dir whose dashed name encodes identically to a nested chain that
// lies beyond the depth bound — the flat twin is found, the nested twin is unreachable.
test("a bound hit after the first match reports exhausted (ambiguity not ruled out)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-exh-")));
  const segments = Array.from({ length: 30 }, (_, i) => `d${i}`);
  const flatTwin = join(base, segments.join("-")); // encodes like the nested chain
  mkdirSync(flatTwin, { recursive: true });
  mkdirSync(join(base, ...segments), { recursive: true }); // nested twin, beyond MAX_DEPTH

  const located = decodeStorageFolder(encodePath(flatTwin))!;
  expect(located.dir).toBe(flatTwin);
  expect(located.ambiguousWith).toBeNull(); // the twin was never reached…
  expect(located.exhausted).toBe(true); // …and the result says so

  rmSync(base, { recursive: true, force: true });
});

test("locateLaunchDir resolves a session file path to its launch dir", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-loc2-")));
  const proj = join(base, "Some Project");
  mkdirSync(proj, { recursive: true });
  const path = join(base, ".projects", encodePath(proj), "id.jsonl");
  expect(locateLaunchDir(path)?.dir).toBe(proj);
  rmSync(base, { recursive: true, force: true });
});
