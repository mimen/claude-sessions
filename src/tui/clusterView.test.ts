import { expect, test } from "bun:test";
import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import type { EpicDisplay } from "../state/groupings.ts";
import { buildClusterView } from "./clusterView.ts";

const row = (id: string): SessionRow => ({ sessionId: id, lastTs: "2026-07-08" } as unknown as SessionRow);
const cat = (o: Partial<CatalogueRow>): CatalogueRow => ({
  sessionId: "", resumeId: null, customTitle: null, kind: "session", completed: false,
  archived: false, parkedTaskId: null, key: null, parentSessionId: null, role: null, resumeCommand: null, project: null,
  cluster: null, gusWork: null, workUnitId: null, groupingId: null, statusLine: null, meta: {}, stage: null, notes: null, updatedAt: null, prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null, ...o,
});

test("buildClusterView: core tier first (★), then WORKERS grouped by epic short-name, no-system last", () => {
  const catMap = new Map<string, CatalogueRow>([
    ["eval", cat({ sessionId: "eval", cluster: "pr-watch", role: "pr-watch-eval" })],
    ["w1", cat({ sessionId: "w1", cluster: "pr-watch", role: "pr-agent", groupingId: "E1" })],
    ["w2", cat({ sessionId: "w2", cluster: "pr-watch", role: "pr-agent", groupingId: "E1" })],
    ["w3", cat({ sessionId: "w3", cluster: "pr-watch", role: "pr-agent", groupingId: null })], // no epic
    ["stray", cat({ sessionId: "stray" })], // no system
  ]);
  const epicMap = new Map<string, EpicDisplay>([
    ["E1", { name: "[Front End] Team-Owned Tokens UI", shortName: "Team Tokens", url: null }],
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

test("buildClusterView: group with ALL sessions retired — outer count is total, inner 'done' fold has retired count", () => {
  // Punch-list guarantee: after a retire cascade, sections don't lie about
  // their contents. The outer group header shows TOTAL rows (live + retired)
  // — this is the current, intentional behavior so the user can see there
  // WAS work here even if it's all done. The nested "✓ done · N" fold then
  // reveals the retired sessions.
  const catMap = new Map<string, CatalogueRow>([
    ["r1", cat({ sessionId: "r1", cluster: "pr-watch", role: "pr-agent", groupingId: "E9", completed: true })],
    ["r2", cat({ sessionId: "r2", cluster: "pr-watch", role: "pr-agent", groupingId: "E9", archived: true })],
  ]);
  const epicMap = new Map<string, EpicDisplay>([
    ["E9", { name: "All Done", shortName: "AllDone", url: null }],
  ]);
  const items = buildClusterView([row("r1"), row("r2")], {
    catMap, epicMap, openSet: new Set(), collapsedSections: new Set(),
  });
  const sections = items.filter((i) => i.kind === "section") as any[];
  const named = (n: string) => sections.findIndex((s) => s.section.name === n);

  const allDone = named("AllDone");
  expect(allDone).toBeGreaterThan(-1);
  // Outer count = total = 2 (both retired).
  expect(sections[allDone].count).toBe(2);

  // A nested "done" fold appears below with count = 2.
  const done = sections.findIndex(
    (s, i) => i > allDone && s.section.name === "done" && s.section.glyph === "✓",
  );
  expect(done).toBeGreaterThan(-1);
  expect(sections[done].count).toBe(2);
});

test("buildClusterView: empty groups are OMITTED entirely — no `(0)` phantom headers", () => {
  // An epic with zero attached sessions must not emit a group header at all.
  // The count-of-zero lie would confuse users into thinking the retire
  // cascade left orphaned metadata.
  const catMap = new Map<string, CatalogueRow>([
    // Only one session in E1; E2 exists in epicMap but has no sessions.
    ["w1", cat({ sessionId: "w1", cluster: "pr-watch", role: "pr-agent", groupingId: "E1" })],
  ]);
  const epicMap = new Map<string, EpicDisplay>([
    ["E1", { name: "Active Epic", shortName: "Active", url: null }],
    ["E2", { name: "Ghost Epic", shortName: "Ghost", url: null }],
  ]);
  const items = buildClusterView([row("w1")], {
    catMap, epicMap, openSet: new Set(), collapsedSections: new Set(),
  });
  const sections = items.filter((i) => i.kind === "section") as any[];
  expect(sections.find((s) => s.section.name === "Ghost")).toBeUndefined();
  expect(sections.find((s) => s.section.name === "Active")).toBeDefined();
});
