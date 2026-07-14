import { expect, test } from "bun:test";
import { resolveLevels, workUnitOf, hookFileBase, type ResolveCtx } from "./resolve-levels.ts";
import type { CatalogueRow } from "../catalogue/db.ts";

const ctx: ResolveCtx = {
  configRoot: "/cfg",
  runtimeRoot: "/rt",
  roleHomeDir: (r) => (r === "pr-agent" ? "/cfg/clusters/pr-watch/roles/pr-agent"
    : r === "control" ? "/cfg/clusters/pr-watch/roles/control" : null),
};

function row(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "s1", resumeId: null, customTitle: null, kind: "session",
    completed: false, archived: false, parkedTaskId: null, key: null,
    parentSessionId: null, role: null, resumeCommand: null, project: null,
    cluster: null, gusWork: null, workUnitId: null, groupingId: null, statusLine: null, meta: {}, stage: null, notes: null, updatedAt: null,
    prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null,
    ...over,
  };
}

const levels = (r: CatalogueRow) => resolveLevels(r, ctx).map((l) => l.level);
const dirOf = (r: CatalogueRow, lvl: string) => resolveLevels(r, ctx).find((l) => l.level === lvl)?.dir;

test("a bare row (no cluster/role) resolves only user + identity", () => {
  expect(levels(row({}))).toEqual(["user", "identity"]);
});

test("user level is always the config root", () => {
  expect(dirOf(row({}), "user")).toBe("/cfg");
});

test("a cluster row adds the cluster level under configRoot/clusters/<c>", () => {
  const r = row({ cluster: "pr-watch" });
  expect(levels(r)).toEqual(["user", "cluster", "identity"]);
  expect(dirOf(r, "cluster")).toBe("/cfg/clusters/pr-watch");
});

test("a known role adds the role level at its registered home_dir", () => {
  const r = row({ cluster: "pr-watch", role: "control" });
  expect(levels(r)).toEqual(["user", "cluster", "role", "identity"]);
  expect(dirOf(r, "role")).toBe("/cfg/clusters/pr-watch/roles/control");
});

test("an UNKNOWN role contributes no role level (fail-open, not fail-loud)", () => {
  const r = row({ cluster: "pr-watch", role: "ghost" });
  expect(levels(r)).toEqual(["user", "cluster", "identity"]); // no role level
});

test("a full fleet worker resolves all six levels in order", () => {
  const r = row({
    cluster: "pr-watch", role: "pr-agent", groupingId: "e123",
    prNumber: 12080, prRepo: "heroku/dashboard",
  });
  expect(levels(r)).toEqual(["user", "cluster", "role", "epic", "work-unit", "identity"]);
});

test("epic level nests under RUNTIME/clusters/<c>/epics/<id> (ADR-0087)", () => {
  // ADR-0087 (2026-07-14): epic-level hook content is per-user work state, not shareable
  // cluster shape — it lives in ~/.ccs (runtime), not ~/.ccs-config (git). Same layout,
  // different base.
  const r = row({ cluster: "pr-watch", role: "pr-agent", groupingId: "e123" });
  expect(dirOf(r, "epic")).toBe("/rt/clusters/pr-watch/epics/e123");
});

test("epic without a cluster does NOT resolve (epic nests under a cluster)", () => {
  const r = row({ role: "pr-agent", groupingId: "e123" });
  expect(levels(r)).not.toContain("epic");
});

test("work-unit prefers PR (repo#num) over gus-work", () => {
  expect(workUnitOf(row({ prRepo: "heroku/dashboard", prNumber: 12080, gusWork: "W-1" })))
    .toBe("heroku-dashboard-12080");
  expect(workUnitOf(row({ gusWork: "W-23392849" }))).toBe("W-23392849");
  expect(workUnitOf(row({}))).toBeNull();
});

test("work-unit level dir uses the composed unit key under the cluster", () => {
  const r = row({ cluster: "pr-watch", role: "pr-agent", prNumber: 12080, prRepo: "heroku/dashboard" });
  expect(dirOf(r, "work-unit")).toBe("/cfg/clusters/pr-watch/work-units/heroku-dashboard-12080");
});

test("identity level lives under the RUNTIME root (never config/git)", () => {
  const r = row({ cluster: "pr-watch", role: "pr-agent", groupingId: "e1", prNumber: 5, prRepo: "a/b" });
  expect(dirOf(r, "identity")).toBe("/rt/clusters/pr-watch/identities/pr-agent/e1/a-b-5");
});

test("a standalone (no-cluster) identity uses the roles/<role> runtime layout", () => {
  const r = row({ role: "control" });
  expect(dirOf(r, "identity")).toBe("/rt/roles/control/identities/control");
});

test("resolution is deterministic — same row resolves identically twice", () => {
  const r = row({ cluster: "pr-watch", role: "pr-agent", prNumber: 1, prRepo: "a/b" });
  expect(JSON.stringify(resolveLevels(r, ctx))).toBe(JSON.stringify(resolveLevels(r, ctx)));
});

test("path components are sanitized (traversal + separators fully stripped)", () => {
  const r = row({ cluster: "../evil", role: null });
  // `..` and `/` both collapse to nothing meaningful — no traversal escapes configRoot.
  expect(dirOf(r, "cluster")).toBe("/cfg/clusters/evil");
  const r2 = row({ cluster: "a/b/../../etc" });
  expect(dirOf(r2, "cluster")?.startsWith("/cfg/clusters/")).toBe(true);
  expect(dirOf(r2, "cluster")).not.toContain("..");
});

test("hookFileBase composes the fixed <dir>/.ccs-hooks/<type> path", () => {
  expect(hookFileBase("/cfg/clusters/pr-watch", "claude-md")).toBe("/cfg/clusters/pr-watch/.ccs-hooks/claude-md");
});
