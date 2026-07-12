import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChangelog, changelogSince, renderDelta, catchUp, validateChangelog } from "./changelog.ts";

const SAMPLE = `# pr-watch CHANGELOG

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

test("parseChangelog: current version is the highest entry, entries oldest-first", () => {
  const log = parseChangelog(SAMPLE);
  expect(log.currentVersion).toBe(3);
  expect(log.entries.map((e) => e.version)).toEqual([1, 2, 3]);
  expect(log.entries[2]!.title).toContain("screenshots auto-invalidate");
});

test("parseChangelog: current version is derived from entries, NOT a drifting header", () => {
  // An author added a (version 3) entry but forgot to bump a stale `version: 1` header.
  // The version must follow the entries so the new entry is never silently skipped.
  const drifted = `# c\nversion: 1\n\n## a (version 1)\nbody\n\n## b (version 2)\nbody\n\n## c (version 3)\nbody\n`;
  expect(parseChangelog(drifted).currentVersion).toBe(3);
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

test("empty text → version 0 / no entries; a lone entry takes its own version", () => {
  expect(parseChangelog("")).toEqual({ currentVersion: 0, entries: [] });
  // A lone entry with no title header still parses; version comes from the entry itself.
  const oneEntry = parseChangelog("## a thing (version 2)\nrequiresRestart: false\nbody");
  expect(oneEntry.currentVersion).toBe(2);
  expect(oneEntry.entries).toHaveLength(1);
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

// --- validateChangelog (authoring backstop, surfaced by `ccs hooks lint`) --------
test("validateChangelog: a clean 1,2,3 run has no problems", () => {
  expect(validateChangelog(parseChangelog(SAMPLE))).toEqual([]);
});

test("validateChangelog: a skipped number is flagged", () => {
  const gap = parseChangelog("## a (version 1)\nbody\n\n## c (version 3)\nbody\n");
  const probs = validateChangelog(gap);
  expect(probs.length).toBe(1);
  expect(probs[0]).toContain("out of sequence");
});

test("validateChangelog: a duplicate version is flagged", () => {
  const dup = parseChangelog("## a (version 1)\nbody\n\n## b (version 2)\nbody\n\n## c (version 2)\nbody\n");
  const probs = validateChangelog(dup);
  expect(probs.some((p) => p.includes("duplicate version 2"))).toBe(true);
});

test("validateChangelog: a run that doesn't start at 1 is flagged", () => {
  const probs = validateChangelog(parseChangelog("## a (version 2)\nbody\n"));
  expect(probs[0]).toContain("expected 1");
});

test("validateChangelog: an empty changelog is valid", () => {
  expect(validateChangelog(parseChangelog(""))).toEqual([]);
});

// --- catchUp core (shared by the start action + `ccs catch-up`) -------------------
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function roots(changelog?: string): { cfg: string; rt: string } {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-cu-cfg-"));
  const rt = mkdtempSync(join(tmpdir(), "ccs-cu-rt-"));
  dirs.push(cfg, rt);
  if (changelog !== undefined) {
    const d = join(cfg, "clusters", "pr-watch");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "CHANGELOG.md"), changelog);
  }
  return { cfg, rt };
}
const R = { cluster: "pr-watch", role: "control" };
const NOW = "2026-07-12T00:00:00Z";

test("catchUp: fresh identity gets the full window, anyRestart reflects the entries, stamp advances", () => {
  const { cfg, rt } = roots(SAMPLE);
  const res = catchUp("pr-watch", R, cfg, rt, NOW);
  expect(res.context).toContain("v0 → v3");
  expect(res.currentVersion).toBe(3);
  expect(res.seenVersion).toBe(0);
  expect(res.anyRestart).toBe(true); // v2 requiresRestart is in the window
  // second call is up to date → silent no-op, anyRestart clears
  const again = catchUp("pr-watch", R, cfg, rt, NOW);
  expect(again.context).toBeNull();
  expect(again.anyRestart).toBe(false);
});

test("catchUp: a delta with no restart entries reports anyRestart false", () => {
  const noRestart = "# c\nversion: 1\n\n## adopt prBranch (version 1)\nrequiresRestart: false\nUse prBranch.\n";
  const { cfg, rt } = roots(noRestart);
  const res = catchUp("pr-watch", R, cfg, rt, NOW);
  expect(res.context).toContain("prBranch");
  expect(res.anyRestart).toBe(false);
});

test("catchUp: no CHANGELOG file → empty result (currentVersion 0)", () => {
  const { cfg, rt } = roots(); // no changelog written
  const res = catchUp("pr-watch", R, cfg, rt, NOW);
  expect(res.context).toBeNull();
  expect(res.currentVersion).toBe(0);
  expect(res.anyRestart).toBe(false);
});
