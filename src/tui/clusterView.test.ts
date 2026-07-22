import { expect, test } from "bun:test";
import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import type { EpicDisplay } from "../state/groupings.ts";
import { buildClusterView } from "./clusterView.ts";

const row = (id: string): SessionRow => ({ sessionId: id, lastTs: "2026-07-08" } as unknown as SessionRow);
const cat = (o: Partial<CatalogueRow>): CatalogueRow => ({
  sessionId: "", resumeId: null, customTitle: null, kind: "session", completed: false,
  archived: false, parkedTaskId: null, key: null, parentSessionId: null, role: null, resumeCommand: null, project: null,
  sessionClass: null,
  cluster: null, gusWork: null, workUnitId: null, groupingId: null, statusLine: null, meta: {}, stage: null, notes: null, updatedAt: null, prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null, identityKey: null, ...o,
});

test("buildClusterView: core tier first, then workers grouped by epic short-name, no-system last", () => {
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
  const core = named("core");
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
  // (no system) trailing, level 0 — now a container with lifecycle sub-groups under it.
  const noSystem = named("(no system)");
  expect(sections[noSystem].section.level).toBe(0);
  // The idle stray lands in an `open` sub-group (level 1) directly after (no system).
  expect(sections[noSystem + 1].section.name).toBe("open");
  expect(sections[noSystem + 1].section.level).toBe(1);
});

test("buildClusterView: skips a redundant no-epic layer when every worker is unassigned", () => {
  const catMap = new Map<string, CatalogueRow>([
    ["w1", cat({ sessionId: "w1", cluster: "event-watch", role: "event-worker", groupingId: null })],
    ["w2", cat({ sessionId: "w2", cluster: "event-watch", role: "event-worker", groupingId: null })],
  ]);
  const items = buildClusterView([row("w1"), row("w2")], {
    catMap, epicMap: new Map(), openSet: new Set(), collapsedSections: new Set(),
  });
  const sections = items.filter((i) => i.kind === "section") as any[];
  const workers = sections.find((s) => s.section.name === "workers");
  expect(workers?.section.level).toBe(1);
  expect(sections.find((s) => s.section.name === "(no epic)")).toBeUndefined();
  const sessions = items.filter((i) => i.kind === "session") as any[];
  expect(sessions.map((i) => i.depth)).toEqual([1, 1]);
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

test("buildClusterView: identity active but all sessions archived → group hidden (matches session-driven archive filter)", () => {
  // Punch-list check: the TUI's archive filtering is SESSION-driven
  // (App.tsx `baseRows` filters on lifecycleOf(session)); identity.archived
  // is never read by the view. If ALL sessions of a fleet or core identity
  // are archived, the identity effectively vanishes from the view unless
  // the user toggles showArchived (which is handled upstream of buildClusterView,
  // so here we simulate that scenario by NOT passing the archived rows).
  //
  // This test locks the invariant: buildClusterView never invents a header
  // for an identity that has zero visible rows, even if the identity is
  // still "active" upstream. No zombie/phantom headers when the filter
  // hides everything under a heading.
  const catMap = new Map<string, CatalogueRow>([
    // Two archived sessions under an active fleet identity; they are
    // pre-filtered by the caller (baseRows), so we don't include them here.
  ]);
  const epicMap = new Map<string, EpicDisplay>([
    ["E-active", { name: "Active Epic With All-Archived Members", shortName: "AllArchived", url: null }],
  ]);
  const items = buildClusterView([], { catMap, epicMap, openSet: new Set(), collapsedSections: new Set() });
  const sections = items.filter((i) => i.kind === "section") as any[];
  // No section for the identity's epic — nothing to show.
  expect(sections.find((s) => s.section.name === "AllArchived")).toBeUndefined();
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

test("buildClusterView: stray (no-system) bucket sub-groups by lifecycle — open / parked / done / archived", () => {
  // Strays get a per-lifecycle split (not the merged retired fold cluster groups use):
  // `open` (idle, incl. active) and `parked` lead expanded; `done` (completed) and
  // `archived` are present but collapsed by default so the loose tail stays legible.
  const catMap = new Map<string, CatalogueRow>([
    ["s-idle", cat({ sessionId: "s-idle" })], // idle → open
    ["s-active", cat({ sessionId: "s-active" })], // idle + live terminal → still open bucket
    ["s-parked", cat({ sessionId: "s-parked", parkedTaskId: "task-1" })],
    ["s-done", cat({ sessionId: "s-done", completed: true })],
    ["s-arch", cat({ sessionId: "s-arch", archived: true })],
  ]);
  const items = buildClusterView(
    [row("s-idle"), row("s-active"), row("s-parked"), row("s-done"), row("s-arch")],
    // s-active is "open" in the live-terminal sense; archived seeded collapsed as it is in prod.
    { catMap, epicMap: new Map(), openSet: new Set(["s-active"]), collapsedSections: new Set(["cluster::none:archived"]) },
  );
  const sections = items.filter((i) => i.kind === "section") as any[];
  const named = (n: string) => sections.findIndex((s) => s.section.name === n);

  // Container header, then the four lifecycle sub-groups in fixed order, all level 1.
  const noSystem = named("(no system)");
  expect(sections[noSystem].section.level).toBe(0);
  for (const [name, count] of [["open", 2], ["parked", 1], ["done", 1], ["archived", 1]] as const) {
    const i = named(name);
    expect(i).toBeGreaterThan(noSystem);
    expect(sections[i].section.level).toBe(1);
    expect(sections[i].count).toBe(count);
  }
  expect(named("open")).toBeLessThan(named("parked"));
  expect(named("parked")).toBeLessThan(named("done"));
  expect(named("done")).toBeLessThan(named("archived"));

  // Collapse defaults: open + parked expanded (their rows emitted), done + archived collapsed
  // (header only, no rows). `done` collapses via the `:done` inversion even though it was not
  // named in collapsedSections; `archived` collapses via its seed.
  expect(sections[named("open")].collapsed).toBe(false);
  expect(sections[named("parked")].collapsed).toBe(false);
  expect(sections[named("done")].collapsed).toBe(true);
  expect(sections[named("archived")].collapsed).toBe(true);
  const idOf = (i: any) => i.kind === "session" && (i.row.sessionId as string);
  const sessionIds = items.map(idOf).filter(Boolean);
  expect(sessionIds).toContain("s-idle");
  expect(sessionIds).toContain("s-active");
  expect(sessionIds).toContain("s-parked");
  expect(sessionIds).not.toContain("s-done"); // collapsed fold hides the row
  expect(sessionIds).not.toContain("s-arch");
});
