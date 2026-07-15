import { expect, test } from "bun:test";
import { identityKey, predecessorsOf } from "./lineage.ts";
import { deriveKey, type CatalogueRow } from "./db.ts";

/**
 * Synthetic-row helper. Pre-ADR-0089 tests set `key: null` and relied on identityKey() to
 * compute it via deriveKey(). Post-ADR-0089, identityKey() reads catalogue.key (stored) or
 * catalogue.identity_key (new FK). This helper auto-populates BOTH shapes from the row's
 * identity-relevant columns so the tests still exercise the join logic without needing a
 * live catalogue behind them.
 */
function row(over: Partial<CatalogueRow>): CatalogueRow {
  const base: CatalogueRow = {
    sessionId: "s", resumeId: null, customTitle: null, kind: "session", completed: false,
    archived: false, parkedTaskId: null, key: null, parentSessionId: null,
    role: null, resumeCommand: null, project: null, cluster: "pr-watch", gusWork: null, workUnitId: null,
    groupingId: null, statusLine: null, meta: {}, stage: null, notes: null, updatedAt: null, prNumber: null, prRepo: null,
    prBranch: null, prState: null, prHeadSha: null, identityKey: null, ...over,
  };
  // Auto-derive the legacy key (row.key) if the caller didn't set one — mirrors what
  // refreshDerivedKey does on real writes.
  if (base.key === null) base.key = deriveKey(base);
  return base;
}

test("identityKey: work-unit id wins (ADR-0057), else derived PR, else gus, else role", () => {
  // ADR-0057: a linked work-unit id is the identity — it wins over the derived string, and matches
  // even if the derived string drifted or the PR was attached after the session started.
  expect(identityKey(row({ workUnitId: "wu_dashboard_12118", prRepo: "heroku/dashboard", prNumber: 12118 }))).toBe("wu:wu_dashboard_12118");
  // legacy (pre-backfill) rows without a work_unit_id fall back to the derived string
  expect(identityKey(row({ prRepo: "heroku/dashboard", prNumber: 12118 }))).toBe("pr:heroku/dashboard#12118");
  expect(identityKey(row({ gusWork: "W-1" }))).toBe("gus:W-1");
  expect(identityKey(row({ role: "control" }))).toBe("role:control");
  expect(identityKey(row({}))).toBeNull();
});

const paths = (m: Record<string, [string | null, string | null]>) =>
  new Map(Object.entries(m).map(([k, [p, t]]) => [k, { path: p, lastTs: t }]));

test("predecessorsOf: returns same-identity siblings, oldest→newest, self excluded", () => {
  const rows = new Map<string, CatalogueRow>([
    ["a", row({ sessionId: "a", role: "control" })],
    ["b", row({ sessionId: "b", role: "control" })],
    ["c", row({ sessionId: "c", role: "control" })],
    ["z", row({ sessionId: "z", role: "eval" })], // different identity
  ]);
  const tp = paths({
    a: ["/t/a.jsonl", "2026-07-01T00:00:00Z"],
    b: ["/t/b.jsonl", "2026-07-03T00:00:00Z"],
    c: ["/t/c.jsonl", "2026-07-02T00:00:00Z"],
    z: ["/t/z.jsonl", "2026-07-05T00:00:00Z"],
  });
  // predecessors of c (the current embodiment) = a, b (control), ordered oldest→newest
  const preds = predecessorsOf(rows, "c", tp);
  expect(preds.map((p) => p.sessionId)).toEqual(["a", "b"]);
  expect(preds[0]!.transcriptPath).toBe("/t/a.jsonl");
});

test("predecessorsOf: a work-unit identity groups its PR embodiments", () => {
  const rows = new Map<string, CatalogueRow>([
    ["x1", row({ sessionId: "x1", role: "pr-agent", prRepo: "heroku/dashboard", prNumber: 12118 })],
    ["x2", row({ sessionId: "x2", role: "pr-agent", prRepo: "heroku/dashboard", prNumber: 12118 })],
    ["y1", row({ sessionId: "y1", role: "pr-agent", prRepo: "heroku/dashboard", prNumber: 99999 })],
  ]);
  const preds = predecessorsOf(rows, "x2", paths({ x1: ["/t/x1.jsonl", "2026-07-01T00:00:00Z"] }));
  expect(preds.map((p) => p.sessionId)).toEqual(["x1"]); // y1 is a different PR
});

test("predecessorsOf: an unkeyed row has no lineage", () => {
  const rows = new Map<string, CatalogueRow>([["u", row({ sessionId: "u", role: null, cluster: null })]]);
  expect(predecessorsOf(rows, "u", paths({}))).toEqual([]);
});

test("predecessorsOf: a solo identity (only self) returns []", () => {
  const rows = new Map<string, CatalogueRow>([["only", row({ sessionId: "only", role: "designer" })]]);
  expect(predecessorsOf(rows, "only", paths({}))).toEqual([]);
});

test("predecessorsOf: null timestamps sort last (still listed)", () => {
  const rows = new Map<string, CatalogueRow>([
    ["a", row({ sessionId: "a", role: "control" })],
    ["b", row({ sessionId: "b", role: "control" })],
    ["cur", row({ sessionId: "cur", role: "control" })],
  ]);
  const preds = predecessorsOf(rows, "cur", paths({ a: ["/t/a.jsonl", "2026-07-01T00:00:00Z"], b: [null, null] }));
  expect(preds.map((p) => p.sessionId)).toEqual(["a", "b"]); // a (has ts) before b (null)
});

test("predecessorsOf: equal/both-null timestamps break ties by sessionId (deterministic, ADR-0072/CI-1)", () => {
  // both null → must order by sessionId, not the JS engine's unstable-sort whim
  const rows = new Map<string, CatalogueRow>([
    ["z", row({ sessionId: "z", role: "control" })],
    ["a", row({ sessionId: "a", role: "control" })],
    ["m", row({ sessionId: "m", role: "control" })],
    ["cur", row({ sessionId: "cur", role: "control" })],
  ]);
  const preds = predecessorsOf(rows, "cur", paths({}));
  expect(preds.map((p) => p.sessionId)).toEqual(["a", "m", "z"]);
  // same timestamp on all → still sessionId order
  const same = predecessorsOf(rows, "cur", paths({
    z: ["/t/z.jsonl", "2026-07-01T00:00:00Z"],
    a: ["/t/a.jsonl", "2026-07-01T00:00:00Z"],
    m: ["/t/m.jsonl", "2026-07-01T00:00:00Z"],
  }));
  expect(same.map((p) => p.sessionId)).toEqual(["a", "m", "z"]);
});
