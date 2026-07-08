import { expect, test } from "bun:test";
import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import { buildClusterView } from "./clusterView.ts";

const row = (id: string): SessionRow => ({ sessionId: id, lastTs: "2026-07-08" } as unknown as SessionRow);
const cat = (o: Partial<CatalogueRow>): CatalogueRow => ({
  sessionId: "", resumeId: null, customTitle: null, kind: "session", completed: false,
  archived: false, parkedTaskId: null, event: null, key: null, parentSessionId: null,
  skill: null, project: null, system: null, gusWork: null, notes: null, updatedAt: null,
  prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null, ...o,
});

test("buildClusterView: groups by system, core roles first with ★, fleet after, no-system last", () => {
  const catMap = new Map<string, CatalogueRow>([
    ["eval", cat({ sessionId: "eval", system: "pr-watch", skill: "pr-watch-eval" })],
    ["w1", cat({ sessionId: "w1", system: "pr-watch", skill: "pr-agent", prNumber: 12113 })],
    ["stray", cat({ sessionId: "stray" })], // no system
  ]);
  const items = buildClusterView([row("eval"), row("w1"), row("stray")], {
    catMap, openSet: new Set(), collapsedSections: new Set(),
  });
  const sections = items.filter((i) => i.kind === "section").map((i) => (i as any).section.name);
  // pr-watch core (eval) before pr-watch fleet (pr-agent); (no system) trailing.
  expect(sections[0]).toContain("pr-watch-eval");
  expect(sections.some((s) => s.includes("pr-agent"))).toBe(true);
  expect(sections[sections.length - 1]).toContain("(no system)");
});
