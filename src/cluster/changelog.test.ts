import { expect, test } from "bun:test";
import { parseChangelog, changelogSince, renderDelta } from "./changelog.ts";

const SAMPLE = `# pr-watch CHANGELOG

version: 3

## 2026-07-09 — screenshots auto-invalidate on UI change (version 3)
requiresRestart: false
The gate now re-proofs screenshots when the UI changed since capture. Re-read the gate skill.

## 2026-07-05 — worktree relocated to ~/work (version 2)
requiresRestart: true
Your cwd moved; the orchestrator will restart you.

## 2026-07-01 — new sensed field prBranch (version 1)
requiresRestart: false
Adopt prBranch from the board instead of deriving it.
`;

test("parseChangelog reads the current version and every entry oldest-first", () => {
  const log = parseChangelog(SAMPLE);
  expect(log.currentVersion).toBe(3);
  expect(log.entries.map((e) => e.version)).toEqual([1, 2, 3]);
  expect(log.entries[2]!.title).toContain("screenshots auto-invalidate");
});

test("parseChangelog captures requiresRestart per entry", () => {
  const log = parseChangelog(SAMPLE);
  const byVer = Object.fromEntries(log.entries.map((e) => [e.version, e.requiresRestart]));
  expect(byVer[1]).toBe(false);
  expect(byVer[2]).toBe(true);
  expect(byVer[3]).toBe(false);
});

test("parseChangelog captures the entry body up to the next entry", () => {
  const log = parseChangelog(SAMPLE);
  expect(log.entries[0]!.body).toContain("Adopt prBranch");
  expect(log.entries[0]!.body).not.toContain("worktree relocated"); // stops at the next heading
});

test("empty / headerless text degrades to version 0 and no entries", () => {
  expect(parseChangelog("")).toEqual({ currentVersion: 0, entries: [] });
  const noHeader = parseChangelog("## a thing (version 2)\nrequiresRestart: false\nbody");
  expect(noHeader.currentVersion).toBe(0);
  expect(noHeader.entries).toHaveLength(1);
});

test("changelogSince returns only entries newer than the seen version", () => {
  const log = parseChangelog(SAMPLE);
  const delta = changelogSince(log, 1);
  expect(delta.entries.map((e) => e.version)).toEqual([2, 3]);
  expect(delta.anyRestart).toBe(true); // v2 requires restart
  expect(delta.currentVersion).toBe(3);
  expect(delta.seenVersion).toBe(1);
});

test("changelogSince at the current version is empty (up to date)", () => {
  const delta = changelogSince(parseChangelog(SAMPLE), 3);
  expect(delta.entries).toHaveLength(0);
  expect(delta.anyRestart).toBe(false);
});

test("a fresh identity (seen 0) sees the full window", () => {
  const delta = changelogSince(parseChangelog(SAMPLE), 0);
  expect(delta.entries.map((e) => e.version)).toEqual([1, 2, 3]);
});

test("renderDelta surfaces version transition, count, restart note, and each entry", () => {
  const delta = changelogSince(parseChangelog(SAMPLE), 1);
  const text = renderDelta("pr-watch", delta);
  expect(text).toContain("pr-watch");
  expect(text).toContain("v1 → v3");
  expect(text).toContain("2 update(s)");
  expect(text).toContain("restart"); // v2 is requiresRestart
  expect(text).toContain("[requiresRestart]");
  expect(text).toContain("screenshots auto-invalidate"); // v3 title present
  expect(text).not.toContain("prBranch"); // v1 is below the seen floor → excluded
});
