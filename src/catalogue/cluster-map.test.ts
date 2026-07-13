import { expect, test } from "bun:test";
import { toMember, buildClusterMap, isCoreRole, clusterMapToJson } from "./cluster-map.ts";
import type { CatalogueRow } from "./db.ts";

const row = (o: Partial<CatalogueRow>): CatalogueRow => ({
  sessionId: "s", resumeId: null, customTitle: null, kind: "session", completed: false,
  archived: false, parkedTaskId: null, key: null, parentSessionId: null, role: null, resumeCommand: null, project: null,
  cluster: null, gusWork: null, workUnitId: null, groupingId: null, statusLine: null, meta: {}, stage: null, activity: null, notes: null, updatedAt: null, prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null, ...o,
});

test("isCoreRole: legacy command-name labels fall back to the hardcoded set (ADR-0062)", () => {
  // These labels aren't declared in any role.toml, so they exercise the LEGACY_CORE_ROLES fallback.
  // The declared path (role.toml `work_unit = none|pr|…`, ADR-0069) is covered by a live smoke test.
  expect(isCoreRole("pr-watch-control")).toBe(true);
  expect(isCoreRole("loop-designer")).toBe(true);
  expect(isCoreRole("pr-agent")).toBe(false);
});

test("buildClusterMap: core group first, fleet folds multi-session PRs to one primary", () => {
  const members = [
    toMember(row({ sessionId: "eval", role: "pr-watch-eval" }), "~/x", "re", true),
    toMember(row({ sessionId: "w-old", role: "pr-agent", prRepo: "r", prNumber: 12120, updatedAt: "2026-07-01" }), "/wt/a", "ro", false),
    toMember(row({ sessionId: "w-new", role: "pr-agent", prRepo: "r", prNumber: 12120, updatedAt: "2026-07-08" }), "/wt/a", "rn", true),
  ];
  const map = buildClusterMap("pr-watch", members);
  expect(map.counts.core).toBe(1);
  expect(map.counts.fleet).toBe(2);
  expect(map.groups[0]?.kind).toBe("core"); // core first
  const fleet = map.groups.find((g) => g.role === "pr-agent")!;
  expect(fleet.members).toHaveLength(1);           // 2 sessions -> 1 primary
  expect(fleet.members[0]!.sessionId).toBe("w-new"); // live/fresher wins
  const foldedSibs = fleet.folded.get("w-new");
  expect(foldedSibs).toHaveLength(1);              // 1 older folded
  expect(foldedSibs?.[0]?.sessionId).toBe("w-old");
});

test("clusterMapToJson: flat roster + folds + closedWithWork roll-up (the agent-facing view)", () => {
  const members = [
    toMember(row({ sessionId: "control", role: "control" }), "~/c", "rc", true), // core, live
    toMember(row({ sessionId: "w-live", role: "pr-agent", prRepo: "r", prNumber: 1 }), "/wt/1", "r1", true),  // fleet, live
    toMember(row({ sessionId: "w-closed", role: "pr-agent", prRepo: "r", prNumber: 2 }), "/wt/2", "r2", false), // fleet, closed + in-flight
    toMember(row({ sessionId: "w-done", role: "pr-agent", prRepo: "r", prNumber: 3, completed: true }), "/wt/3", "r3", false), // fleet, retired
  ];
  const j = clusterMapToJson(buildClusterMap("pr-watch", members));
  expect(j.cluster).toBe("pr-watch");
  expect(j.members).toHaveLength(4);
  expect(j.members.find((m) => m.sessionId === "control")!.kind).toBe("core");
  expect(j.members.find((m) => m.sessionId === "w-live")!.kind).toBe("fleet");
  // closedWithWork = fleet, not live, not retired → only w-closed (w-done is completed, w-live is live)
  expect(j.closedWithWork.map((m) => m.sessionId)).toEqual(["w-closed"]);
  expect(j.closedWithWork[0]!.prNumber).toBe(2);
});
