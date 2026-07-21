import { expect, test } from "bun:test";
import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import { buildStateItems, classify } from "./stateGroups.ts";

const NOW = Date.parse("2026-06-20T00:00:00Z");
const cat = (over: Partial<CatalogueRow> = {}): CatalogueRow => ({
  sessionId: "s",
  resumeId: null,
  customTitle: null,
  kind: "session",
  completed: false,
  archived: false,
  parkedTaskId: null,
  key: null,
  parentSessionId: null,
  sessionClass: null,
  role: null,
  resumeCommand: null,
  project: null,
  cluster: null,
  gusWork: null, workUnitId: null,
  groupingId: null, statusLine: null, meta: {}, stage: null,
  notes: null,
  updatedAt: null,
  prNumber: null,
  prRepo: null,
  prBranch: null,
  prState: null,
  prHeadSha: null,
  identityKey: null,
  ...over,
});
const row = (id: string, lastTs: string): SessionRow =>
  ({ sessionId: id, lastTs, isSubagent: false } as unknown as SessionRow);

test("classify: loop wins over everything", () => {
  expect(classify(row("s", "2026-06-19T00:00:00Z"), cat({ kind: "loop", archived: true }), true, NOW)).toBe("loops");
});

test("classify: lifecycle precedence then open then age", () => {
  expect(classify(row("s", "2026-06-19T00:00:00Z"), cat({ archived: true }), false, NOW)).toBe("archived");
  expect(classify(row("s", "2026-06-19T00:00:00Z"), cat({ completed: true }), false, NOW)).toBe("done");
  expect(classify(row("s", "2026-06-19T00:00:00Z"), cat({ parkedTaskId: "t" }), false, NOW)).toBe("parked");
  expect(classify(row("s", "2026-06-19T00:00:00Z"), null, true, NOW)).toBe("active");
  expect(classify(row("s", "2026-06-19T00:00:00Z"), null, false, NOW)).toBe("recent"); // 1d ago
  expect(classify(row("s", "2026-05-01T00:00:00Z"), null, false, NOW)).toBe("stale"); // >2w
});

test("buildStateItems: uses physical costs for a section total while retaining recursive costs for sort", () => {
  const parent = { ...row("parent", "2026-06-19T00:00:00Z"), costUSD: 5 };
  const child = { ...row("child", "2026-06-19T00:00:00Z"), costUSD: 10 };
  const recursive = new Map([["parent", 15], ["child", 10]]);
  const items = buildStateItems([parent, child], {
    catMap: new Map(),
    openSet: new Set(),
    nowMs: NOW,
    collapsedSections: new Set(),
    costOf: (session) => recursive.get(session.sessionId) ?? 0,
    sectionCostOf: (session) => session.costUSD,
  });
  const section = items.find((item) => item.kind === "section" && item.section.key === "recent");
  expect(section?.kind === "section" ? section.cost : null).toBe(15);
});

test("buildStateItems: section order + default collapse", () => {
  const rows = [
    row("active1", "2026-06-19T00:00:00Z"),
    row("loop1", "2026-06-19T00:00:00Z"),
    row("stale1", "2026-04-01T00:00:00Z"),
  ];
  const catMap = new Map<string, CatalogueRow>([["loop1", cat({ sessionId: "loop1", kind: "loop" })]]);
  const items = buildStateItems(rows, {
    catMap,
    openSet: new Set(["active1"]),
    nowMs: NOW,
    collapsedSections: new Set(["stale", "done", "archived"]),
  });
  const kinds = items.map((i) => (i.kind === "section" ? `#${i.section.key}` : "row"));
  // ACTIVE(row) then LOOPS(row) then STALE(collapsed -> header only)
  expect(kinds).toEqual(["#active", "row", "#loops", "row", "#stale"]);
});
