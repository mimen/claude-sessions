import { expect, test } from "bun:test";
import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow, EpicRow } from "../catalogue/db.ts";
import { buildClusterView } from "./clusterView.ts";

const row = (id: string): SessionRow => ({ sessionId: id, lastTs: "2026-07-08" } as unknown as SessionRow);
const cat = (o: Partial<CatalogueRow>): CatalogueRow => ({
  sessionId: "", resumeId: null, customTitle: null, kind: "session", completed: false,
  archived: false, parkedTaskId: null, event: null, key: null, parentSessionId: null,
  skill: null, project: null, system: null, gusWork: null, epicId: null, notes: null, updatedAt: null,
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
  const sections = items.filter((i) => i.kind === "section").map((i) => (i as any).section.name);
  // core tier first (the star role), before any workers tier.
  expect(sections[0]).toContain("core");
  expect(sections[0]).toContain("pr-watch-eval");
  // workers grouped by epic SHORT name; the 2-session epic before the no-epic single.
  const teamTokens = sections.findIndex((s) => s.includes("workers") && s.includes("Team Tokens"));
  const noEpic = sections.findIndex((s) => s.includes("workers") && s.includes("(no epic)"));
  expect(teamTokens).toBeGreaterThan(-1);
  expect(noEpic).toBeGreaterThan(teamTokens); // bigger epic before no-epic
  // (no system) trailing.
  expect(sections[sections.length - 1]).toContain("(no system)");
});
