import { expect, test } from "bun:test";
import { toMember, buildClusterMap, isCoreRole } from "./cluster-map.ts";
import type { CatalogueRow } from "./db.ts";

const row = (o: Partial<CatalogueRow>): CatalogueRow => ({
  sessionId: "s", resumeId: null, customTitle: null, kind: "session", completed: false,
  archived: false, parkedTaskId: null, event: null, key: null, parentSessionId: null,
  skill: null, project: null, system: "pr-watch", gusWork: null, epicId: null, notes: null, updatedAt: null,
  prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null, ...o,
});

test("isCoreRole: control/concierge/eval/designer are core; pr-agent is not", () => {
  expect(isCoreRole("pr-watch-control")).toBe(true);
  expect(isCoreRole("loop-designer")).toBe(true);
  expect(isCoreRole("pr-agent")).toBe(false);
});

test("buildClusterMap: core group first, fleet folds multi-session PRs to one primary", () => {
  const members = [
    toMember(row({ sessionId: "eval", skill: "pr-watch-eval" }), "~/x", "re", true),
    toMember(row({ sessionId: "w-old", skill: "pr-agent", prRepo: "r", prNumber: 12120, updatedAt: "2026-07-01" }), "/wt/a", "ro", false),
    toMember(row({ sessionId: "w-new", skill: "pr-agent", prRepo: "r", prNumber: 12120, updatedAt: "2026-07-08" }), "/wt/a", "rn", true),
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
