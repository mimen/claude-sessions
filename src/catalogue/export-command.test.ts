/**
 * Tests for the D1 export contract. The export shape is the tool↔cluster interface — engines
 * couple to THIS schema instead of the private SQLite. Changes here are semver-breaking for
 * any cluster reading the JSON, so any change to `EXPORT_SCHEMA_VERSION` bumps a `schema` field
 * consumers can gate on.
 */
import { expect, test } from "bun:test";
import { openCatalogue, setRole, setCluster, stampPrFacts, setGusWork, setWorkUnitId } from "./db.ts";
import { catalogueExport, buildExport, EXPORT_SCHEMA_VERSION } from "./export-command.ts";

const NOW = "2026-06-20T00:00:00Z";

test("export: schema field is stable", () => {
  const db = openCatalogue(":memory:");
  const out = catalogueExport(db, { cluster: null, role: null });
  expect(out.schema).toBe(EXPORT_SCHEMA_VERSION);
  expect(out.count).toBe(0);
  expect(out.rows).toEqual([]);
});

test("export: filters by cluster", () => {
  const db = openCatalogue(":memory:");
  setCluster(db, "s1", "pr-watch", NOW);
  setCluster(db, "s2", "other", NOW);
  setRole(db, "s1", "pr-agent", NOW);
  setRole(db, "s2", "pr-agent", NOW);
  const out = catalogueExport(db, { cluster: "pr-watch", role: null });
  expect(out.count).toBe(1);
  expect(out.rows[0]!.sessionId).toBe("s1");
  expect(out.cluster).toBe("pr-watch");
});

test("export: filters by cluster AND role", () => {
  const db = openCatalogue(":memory:");
  setCluster(db, "s1", "pr-watch", NOW); setRole(db, "s1", "pr-agent", NOW);
  setCluster(db, "s2", "pr-watch", NOW); setRole(db, "s2", "control", NOW);
  setCluster(db, "s3", "pr-watch", NOW); setRole(db, "s3", "pr-agent", NOW);
  const out = catalogueExport(db, { cluster: "pr-watch", role: "pr-agent" });
  expect(out.count).toBe(2);
  expect(new Set(out.rows.map((r) => r.sessionId))).toEqual(new Set(["s1", "s3"]));
});

test("export: rows carry the auto-derived key", () => {
  const db = openCatalogue(":memory:");
  setCluster(db, "s1", "pr-watch", NOW); setRole(db, "s1", "pr-agent", NOW);
  stampPrFacts(db, "s1", { prNumber: 42, prRepo: "heroku/dashboard", prBranch: "b", prState: "open", prHeadSha: "sha" }, NOW);
  const out = catalogueExport(db, { cluster: "pr-watch", role: null });
  expect(out.rows[0]!.key).toBe("pr:heroku/dashboard#42");
});

test("export: work-unit id wins over PR facts in key", () => {
  const db = openCatalogue(":memory:");
  setCluster(db, "s1", "pr-watch", NOW); setRole(db, "s1", "pr-agent", NOW);
  stampPrFacts(db, "s1", { prNumber: 42, prRepo: "o/r", prBranch: "b", prState: "open", prHeadSha: "s" }, NOW);
  setWorkUnitId(db, "s1", "wu_xyz", NOW);
  const out = catalogueExport(db, { cluster: null, role: null });
  expect(out.rows[0]!.key).toBe("wu:wu_xyz");
});

test("buildExport: pure — same inputs, deterministic output shape", () => {
  const rows = [
    {
      sessionId: "s1", resumeId: null, customTitle: null, kind: "session" as const,
      completed: false, archived: false, parkedTaskId: null, key: "role:x",
      parentSessionId: null, role: "x", resumeCommand: null, project: null,
      cluster: "c1", gusWork: null, workUnitId: null, groupingId: null,
      stage: null, statusLine: null, meta: {}, notes: null, updatedAt: NOW,
      prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null,
    },
  ];
  const out = buildExport(rows, { cluster: "c1", role: null }, NOW);
  expect(out.schema).toBe(EXPORT_SCHEMA_VERSION);
  expect(out.generatedAt).toBe(NOW);
  expect(out.count).toBe(1);
  expect(out.rows[0]!.key).toBe("role:x");
});
