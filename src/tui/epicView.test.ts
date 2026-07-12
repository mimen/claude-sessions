import { expect, test } from "bun:test";
import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import type { EpicDisplay } from "../state/groupings.ts";
import { buildEpicView } from "./epicView.ts";

const row = (id: string): SessionRow => ({ sessionId: id, lastTs: "2026-07-08" } as unknown as SessionRow);
const cat = (o: Partial<CatalogueRow>): CatalogueRow => ({
  sessionId: "", resumeId: null, customTitle: null, kind: "session", completed: false,
  archived: false, parkedTaskId: null, key: null, parentSessionId: null,
  role: null, resumeCommand: null, project: null, system: null, gusWork: null, workUnitId: null, epicId: null, statusLine: null, meta: {}, stage: null, activity: null, notes: null,
  updatedAt: null, prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null, ...o,
});

test("buildEpicView: groups system members by epic, strips team prefix, no-epic last, excludes no-system", () => {
  const catMap = new Map<string, CatalogueRow>([
    ["a", cat({ sessionId: "a", system: "pr-watch", epicId: "E1" })],
    ["b", cat({ sessionId: "b", system: "pr-watch", epicId: "E1" })],
    ["c", cat({ sessionId: "c", system: "pr-watch", epicId: null })], // no epic
    ["x", cat({ sessionId: "x" })], // no system -> excluded
  ]);
  const epicMap = new Map<string, EpicDisplay>([
    ["E1", { name: "[Front End] FY27 Metered Pricing", shortName: "Metered", url: "http://gus/E1" }],
  ]);
  const items = buildEpicView([row("a"), row("b"), row("c"), row("x")], {
    catMap, epicMap, collapsedSections: new Set(),
  });
  const sections = items.filter((i) => i.kind === "section") as any[];
  expect(sections[0].section.name).toBe("Metered Pricing"); // team + FY prefix stripped
  expect(sections[0].count).toBe(2);
  expect(sections[sections.length - 1].section.name).toBe("(no epic)");
  // no-system session excluded entirely
  const allSessions = items.filter((i) => i.kind === "session") as any[];
  expect(allSessions.some((s) => s.row.sessionId === "x")).toBe(false);
});
