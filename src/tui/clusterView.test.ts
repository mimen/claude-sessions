import { expect, test } from "bun:test";
import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow, EpicRow } from "../catalogue/db.ts";
import { buildClusterView } from "./clusterView.ts";

const row = (id: string): SessionRow => ({ sessionId: id, lastTs: "2026-07-08" } as unknown as SessionRow);
const cat = (o: Partial<CatalogueRow>): CatalogueRow => ({
  sessionId: "", resumeId: null, customTitle: null, kind: "session", completed: false,
  archived: false, parkedTaskId: null, event: null, key: null, parentSessionId: null,
  skill: null, project: null, system: null, gusWork: null, epicId: null, phase: null, notes: null, updatedAt: null,
  prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null, ...o,
});

test("buildClusterView: core tier first (★), then WORKERS grouped by epic short-name, no-system last", () => {
  const catMap = new Map<string, CatalogueRow>([
    ["eval", cat({ sessionId: "eval", system: "pr-watch", skill: "pr-watch-eval" })],
    ["w1", cat({ sessionId: "w1", system: "pr-watch", skill: "pr-agent", epicId: "E1" })],
    ["w2", cat({ sessionId: "w2", system: "pr-watch", skill: "pr-agent", epicId: "E1" })],
    ["w3", cat({ sessionId: "w3", system: "pr-watch", skill: "pr-agent", epicId: null })], // no epic
    ["stray", cat({ sessionId: "stray" })], // no system
  ]);
  const epicMap = new Map<string, EpicRow>([
    ["E1", { epicId: "E1", name: "[Front End] Team-Owned Tokens UI", shortName: "Team Tokens", url: null, updatedAt: null }],
  ]);
  const items = buildClusterView([row("eval"), row("w1"), row("w2"), row("w3"), row("stray")], {
    catMap, epicMap, openSet: new Set(), collapsedSections: new Set(),
  });
  const sections = items.filter((i) => i.kind === "section") as any[];
  const named = (n: string) => sections.findIndex((s) => s.section.name === n && s.kind === "section");
  // Nested headers: level-0 cluster, level-1 core/workers tiers, level-2 epic/role groups.
  expect(sections[0].section.name).toBe("pr-watch");
  expect(sections[0].section.level).toBe(0);
  const core = named("core ★");
  const workers = named("workers");
  expect(core).toBeGreaterThan(-1);
  expect(sections[core].section.level).toBe(1);
  expect(sections[workers].section.level).toBe(1);
  // core is FLAT (no per-role subgroups) — role shows in the role column, not headers.
  expect(sections[core].count).toBe(1); // the one eval core session
  expect(named("pr-watch-eval")).toBe(-1); // no per-role subheader
  // epic subgroups: Team Tokens (2) before (no epic) (1), both level 2, under workers.
  const tt = named("Team Tokens");
  const noEpic = named("(no epic)");
  expect(sections[tt].section.level).toBe(2);
  expect(tt).toBeGreaterThan(workers);
  expect(noEpic).toBeGreaterThan(tt);
  // (no system) trailing, level 0.
  expect(sections[sections.length - 1].section.name).toBe("(no system)");
});
