/**
 * ADR-0092 approach A: resolveResumeCwd recreates a DELETED anchor dir so a stranded session
 * (removed worktree / cleaned scratch) resumes again — and deliberately does NOT do so for a
 * cwd that still exists but has drifted (symlink), which needs a transcript move instead.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveResumeCwd } from "./command.ts";
import { encodePath } from "./locate.ts";

/** A SessionRow shaped enough for resolveResumeCwd, whose storage folder encodes `anchor`. */
function rowFor(anchor: string, projectRoot: string) {
  return {
    path: join("/Users/nobody/.claude/projects", encodePath(anchor), "sid.jsonl"),
    cwd: anchor,
    projectRoot,
    resumeId: "sid",
  } as never;
}

test("recreates a deleted anchor dir so the session resumes", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-anchor-")));
  const anchor = join(base, "removed-worktree"); // never created — simulates a deleted worktree
  expect(existsSync(anchor)).toBe(false);

  const res = resolveResumeCwd(rowFor(anchor, base));

  expect("error" in res).toBe(false);
  if ("error" in res) return;
  expect(res.cwd).toBe(anchor);
  expect(res.note).toContain("recreated");
  expect(existsSync(anchor)).toBe(true); // anchor now maps to the storage folder → claude finds it

  rmSync(base, { recursive: true, force: true });
});

test("does NOT recreate a cwd that still exists but is a symlink (drift) — falls back with a note", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-anchor-")));
  const target = join(base, "target");
  const link = join(base, "link"); // exists, but realpath(link) = target, so encode(realpath) != folder
  mkdirSync(target);
  symlinkSync(target, link);

  const res = resolveResumeCwd(rowFor(link, base));

  expect("error" in res).toBe(false);
  if (!("error" in res)) {
    expect(res.cwd).toBe(link);
    expect(res.note).toContain("could not confirm"); // soft fallback, unchanged — A doesn't touch this
  }

  rmSync(base, { recursive: true, force: true });
});
