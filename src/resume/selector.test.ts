import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openCatalogue, setRole, setSystem, stampPrFacts, setGusWork, setSessionEpic } from "../catalogue/db.ts";
import { resolveSelector } from "./selector.ts";

const NOW = "2026-07-10T00:00:00Z";

/** A catalogue seeded in-memory + a stub index that knows a fixed set of session ids. */
function seed(): { cat: Database; idx: Database } {
  const cat = openCatalogue(":memory:");
  const idx = new Database(":memory:");
  idx.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, resume_id TEXT)");
  return { cat, idx };
}

test("PR selector: `owner/repo#123` matches that repo's PR sessions", () => {
  const { cat, idx } = seed();
  stampPrFacts(cat, "s1", { prNumber: 123, prRepo: "heroku/dashboard", prBranch: "", prState: "open", prHeadSha: "" }, NOW);
  stampPrFacts(cat, "s2", { prNumber: 123, prRepo: "other/repo", prBranch: "", prState: "open", prHeadSha: "" }, NOW);
  const r = resolveSelector(cat, idx, "heroku/dashboard#123")!;
  expect(r.kind).toBe("pr");
  expect(r.sessionIds).toEqual(["s1"]);
});

test("PR selector: bare `#123` matches the number across repos", () => {
  const { cat, idx } = seed();
  stampPrFacts(cat, "s1", { prNumber: 123, prRepo: "a/b", prBranch: "", prState: "open", prHeadSha: "" }, NOW);
  stampPrFacts(cat, "s2", { prNumber: 123, prRepo: "c/d", prBranch: "", prState: "open", prHeadSha: "" }, NOW);
  const r = resolveSelector(cat, idx, "#123")!;
  expect(r.kind).toBe("pr");
  expect(r.sessionIds.sort()).toEqual(["s1", "s2"]);
});

test("GUS work item selector (W-number, case-insensitive)", () => {
  const { cat, idx } = seed();
  setGusWork(cat, "s1", "W-1234567", NOW);
  const r = resolveSelector(cat, idx, "w-1234567")!;
  expect(r.kind).toBe("gus-work");
  expect(r.sessionIds).toEqual(["s1"]);
});

test("role selector (inferred from a bare word not matching a cluster)", () => {
  const { cat, idx } = seed();
  setRole(cat, "s1", "control", NOW);
  setRole(cat, "s2", "control", NOW);
  const r = resolveSelector(cat, idx, "control")!;
  expect(r.kind).toBe("role");
  expect(r.sessionIds.sort()).toEqual(["s1", "s2"]);
});

test("cluster wins over role when a bare word is a known cluster (fixed probe order)", () => {
  const { cat, idx } = seed();
  setSystem(cat, "s1", "pr-watch", NOW);
  setRole(cat, "s2", "pr-watch", NOW); // pathological: a role named like the cluster
  const r = resolveSelector(cat, idx, "pr-watch")!;
  expect(r.kind).toBe("cluster");
  expect(r.sessionIds).toContain("s1");
});

test("--role pin skips inference even when the token also names a cluster", () => {
  const { cat, idx } = seed();
  setSystem(cat, "s1", "pr-watch", NOW);
  setRole(cat, "s2", "pr-watch", NOW);
  const r = resolveSelector(cat, idx, "pr-watch", { pin: "role" })!;
  expect(r.kind).toBe("role");
  expect(r.sessionIds).toEqual(["s2"]);
});

test("session-id selector returns the id itself (even if not yet indexed)", () => {
  const { cat, idx } = seed();
  const uuid = "2ed1df23-e1d3-4381-b285-bad39a4f5c00";
  const r = resolveSelector(cat, idx, uuid)!;
  expect(r.kind).toBe("session-id");
  expect(r.sessionIds).toEqual([uuid]);
});

test("unmatched token returns null", () => {
  const { cat, idx } = seed();
  expect(resolveSelector(cat, idx, "nothing-matches-this")).toBeNull();
});

test("epic selector resolves a shortname to its grouping's sessions", () => {
  const root = process.env.CCS_ROOT;
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const tmp = mkdtempSync(join(tmpdir(), "ccs-sel-"));
  process.env.CCS_ROOT = tmp;
  try {
    const { upsertGrouping } = require("./../state/groupings.ts");
    const { cat, idx } = seed();
    setSystem(cat, "s1", "pr-watch", NOW);
    setSessionEpic(cat, "s1", "e-42", NOW);
    upsertGrouping("pr-watch", "e-42", { label: "FY27 Metered Pricing", shortName: "Metered" }, NOW);
    const r = resolveSelector(cat, idx, "Metered", { cluster: "pr-watch" })!;
    expect(r.kind).toBe("epic");
    expect(r.sessionIds).toEqual(["s1"]);
  } finally {
    root === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = root);
    rmSync(tmp, { recursive: true, force: true });
  }
});
