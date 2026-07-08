import { expect, test } from "bun:test";
import type { CatalogueRow } from "../catalogue/db.ts";
import { buildGroupsView } from "./groupsView.ts";
import { cat, row } from "./testFixtures.ts";

const shape = (items: ReturnType<typeof buildGroupsView>): string[] =>
  items.map((i) => (i.kind === "section" ? `#${i.section.key}` : i.kind === "session" ? i.row.sessionId : "?"));

test("role sections group a role's bodies ahead of constellations and solo", () => {
  const rows = [
    row("body1", "2026-06-18T00:00:00Z"),
    row("body2", "2026-06-19T00:00:00Z"),
    row("lone", "2026-06-19T00:00:00Z"),
  ];
  const catMap = new Map<string, CatalogueRow>([
    ["body1", cat({ sessionId: "body1", role: "todoist-scout" })],
    ["body2", cat({ sessionId: "body2", role: "todoist-scout" })],
  ]);
  const items = buildGroupsView(rows, { catMap, openSet: new Set(), collapsedSections: new Set() });
  // role section first (bodies age-ordered, most recent first), then SOLO
  expect(shape(items)).toEqual(["#r:todoist-scout", "body2", "body1", "#solo", "lone"]);
  const section = items[0]!;
  expect(section.kind === "section" && section.section.name).toBe("TODOIST-SCOUT");
});

test("a constellation whose root has a role lands intact inside the role section", () => {
  const rows = [
    row("root", "2026-06-18T00:00:00Z"),
    row("kid", "2026-06-19T00:00:00Z"),
    row("other", "2026-06-19T00:00:00Z"),
  ];
  const catMap = new Map<string, CatalogueRow>([
    ["root", cat({ sessionId: "root", role: "event-watch" })],
    ["kid", cat({ sessionId: "kid", parentSessionId: "root" })],
  ]);
  const items = buildGroupsView(rows, { catMap, openSet: new Set(), collapsedSections: new Set() });
  expect(shape(items)).toEqual(["#r:event-watch", "root", "kid", "#solo", "other"]);
});

test("without roles, grouping is unchanged (constellations, loops, solo)", () => {
  const rows = [row("root", "2026-06-18T00:00:00Z"), row("kid", "2026-06-19T00:00:00Z"), row("l", "2026-06-19T00:00:00Z")];
  const catMap = new Map<string, CatalogueRow>([
    ["kid", cat({ sessionId: "kid", parentSessionId: "root" })],
    ["l", cat({ sessionId: "l", kind: "loop" })],
  ]);
  const items = buildGroupsView(rows, { catMap, openSet: new Set(), collapsedSections: new Set() });
  expect(shape(items)).toEqual(["#c:root", "root", "kid", "#loops", "l"]);
});

test("a role child splits into its own role group with its role-less subtree; parent keeps the rest", () => {
  // coordinator (role event-watch) → worker (role event-worker) → worker's helper (no role).
  const rows = [
    row("coord", "2026-06-18T00:00:00Z"),
    row("worker", "2026-06-19T00:00:00Z"),
    row("helper", "2026-06-19T06:00:00Z"),
    row("aide", "2026-06-17T00:00:00Z"), // coordinator's own role-less child
  ];
  const catMap = new Map<string, CatalogueRow>([
    ["coord", cat({ sessionId: "coord", role: "event-watch" })],
    ["worker", cat({ sessionId: "worker", role: "event-worker", parentSessionId: "coord" })],
    ["helper", cat({ sessionId: "helper", parentSessionId: "worker" })],
    ["aide", cat({ sessionId: "aide", parentSessionId: "coord" })],
  ]);
  const items = buildGroupsView(rows, { catMap, openSet: new Set(), collapsedSections: new Set() });
  // event-worker section is fresher (helper 06:00) so it leads; worker brings helper, coord keeps aide.
  expect(shape(items)).toEqual([
    "#r:event-worker", "worker", "helper",
    "#r:event-watch", "coord", "aide",
  ]);
});

test("role bodies order by their subtree's recency, not the root's own age", () => {
  // Body A: stale root with a fresh child. Body B: standalone, between the two.
  const rows = [
    row("rootA", "2026-06-01T00:00:00Z"),
    row("kidA", "2026-06-19T12:00:00Z"),
    row("bodyB", "2026-06-19T00:00:00Z"),
  ];
  const catMap = new Map<string, CatalogueRow>([
    ["rootA", cat({ sessionId: "rootA", role: "ops-watch" })],
    ["kidA", cat({ sessionId: "kidA", parentSessionId: "rootA" })],
    ["bodyB", cat({ sessionId: "bodyB", role: "ops-watch" })],
  ]);
  const items = buildGroupsView(rows, { catMap, openSet: new Set(), collapsedSections: new Set() });
  // rootA's subtree is freshest via kidA, so it renders above bodyB.
  expect(shape(items)).toEqual(["#r:ops-watch", "rootA", "kidA", "bodyB"]);
});

test("a role section can be collapsed like any other", () => {
  const rows = [row("b", "2026-06-18T00:00:00Z"), row("x", "2026-06-19T00:00:00Z")];
  const catMap = new Map<string, CatalogueRow>([["b", cat({ sessionId: "b", role: "ops-watch" })]]);
  const items = buildGroupsView(rows, {
    catMap,
    openSet: new Set(),
    collapsedSections: new Set(["r:ops-watch"]),
  });
  expect(shape(items)).toEqual(["#r:ops-watch", "#solo", "x"]);
});
