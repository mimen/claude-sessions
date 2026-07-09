import { expect, test } from "bun:test";
import type { CatalogueRow, Kind } from "./db.ts";
import { renderTab } from "./render-tab.ts";

/** Build a full CatalogueRow fixture. */
const row = (over: Partial<CatalogueRow> = {}): CatalogueRow => ({
  sessionId: "test-session",
  resumeId: null,
  customTitle: null,
  kind: "session",
  completed: false,
  archived: false,
  parkedTaskId: null,
  event: null,
  key: null,
  parentSessionId: null,
  skill: null,
  project: null,
  system: null,
  gusWork: null,
  epicId: null, phase: null,
  notes: null,
  updatedAt: null,
  prNumber: null,
  prRepo: null,
  prBranch: null,
  prState: null,
  prHeadSha: null,
  ...over,
});

test("renderTab: session with PR facts renders #<num> title", () => {
  const r = row({
    prNumber: 123,
    prRepo: "heroku/dashboard",
    customTitle: "Fix navbar alignment",
  });
  const ops = renderTab(r, "session");
  expect(ops.title).toBe("#123 Fix navbar alignment");
});

test("renderTab: session without PR falls back to custom title", () => {
  const r = row({ customTitle: "Manual refactor" });
  const ops = renderTab(r, "session");
  expect(ops.title).toBe("Manual refactor");
});

test("renderTab: session with key in description", () => {
  const r = row({
    key: "Q1-planning",
    system: "pr-watch",
    gusWork: null,
    epicId: null, phase: null,
  });
  const ops = renderTab(r, "session");
  expect(ops.description).toContain("pr-watch");
  expect(ops.description).toContain("Q1-planning");
});

test("renderTab: session with project in description", () => {
  const r = row({ project: "ccs" });
  const ops = renderTab(r, "session");
  expect(ops.description).toContain("ccs");
});

test("renderTab: loop uses skill or custom title", () => {
  const loopWithSkill = row({ kind: "loop", skill: "pr-watch-2" });
  const ops1 = renderTab(loopWithSkill, "loop");
  expect(ops1.title).toBe("pr-watch-2");

  const loopWithTitle = row({ kind: "loop", customTitle: "/loop custom" });
  const ops2 = renderTab(loopWithTitle, "loop");
  expect(ops2.title).toBe("/loop custom");
});

test("renderTab: lifecycle idle -> no status pill", () => {
  const r = row({});
  const ops = renderTab(r, "session");
  expect(ops.statusPill).toBeNull();
});

test("renderTab: lifecycle parked -> status pill with parked label", () => {
  const r = row({ parkedTaskId: "t-123" });
  const ops = renderTab(r, "session");
  expect(ops.statusPill).not.toBeNull();
  expect(ops.statusPill?.key).toBe("ccs_lifecycle");
  expect(ops.statusPill?.label).toMatch(/parked/i);
});

test("renderTab: lifecycle completed -> done status pill", () => {
  const r = row({ completed: true });
  const ops = renderTab(r, "session");
  expect(ops.statusPill).not.toBeNull();
  expect(ops.statusPill?.key).toBe("ccs_lifecycle");
  expect(ops.statusPill?.label).toMatch(/done/i);
});

test("renderTab: lifecycle archived -> archived status pill", () => {
  const r = row({ archived: true });
  const ops = renderTab(r, "session");
  expect(ops.statusPill).not.toBeNull();
  expect(ops.statusPill?.key).toBe("ccs_lifecycle");
  expect(ops.statusPill?.label).toMatch(/archived/i);
});

test("renderTab: PR state open -> color Aqua", () => {
  const r = row({ prNumber: 1, prState: "open" });
  const ops = renderTab(r, "session");
  expect(ops.color).toBe("Aqua");
});

test("renderTab: PR state merged -> color Green", () => {
  const r = row({ prNumber: 1, prState: "merged" });
  const ops = renderTab(r, "session");
  expect(ops.color).toBe("Green");
});

test("renderTab: PR state closed (not merged) -> color Charcoal", () => {
  const r = row({ prNumber: 1, prState: "closed" });
  const ops = renderTab(r, "session");
  expect(ops.color).toBe("Charcoal");
});

test("renderTab: lifecycle overrides PR state for color (completed wins)", () => {
  const r = row({ prNumber: 1, prState: "open", completed: true });
  const ops = renderTab(r, "session");
  expect(ops.color).toBe("Green");
});

test("renderTab: lifecycle archived -> faint color (Charcoal)", () => {
  const r = row({ archived: true });
  const ops = renderTab(r, "session");
  expect(ops.color).toBe("Charcoal");
});

test("renderTab: loop kind gets distinct color (Purple)", () => {
  const r = row({ kind: "loop", skill: "event-watch" });
  const ops = renderTab(r, "loop");
  expect(ops.color).toBe("Purple");
});
