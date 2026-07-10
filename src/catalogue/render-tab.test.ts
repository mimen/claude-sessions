import { expect, test } from "bun:test";
import type { CatalogueRow, Kind } from "./db.ts";
import { renderTab, applyPaintOverride, type TabRenderOps } from "./render-tab.ts";

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
  role: null,
  resumeCommand: null,
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

// ── applyPaintOverride (cmux-paint, ADR-0027/0044) ──────────────────────────────
const baseOps: TabRenderOps = { title: "#12080 Fix navbar", description: "pr-watch", color: "Aqua", statusPill: null };

test("applyPaintOverride: null override leaves base ops unchanged", () => {
  expect(applyPaintOverride(baseOps, null)).toEqual(baseOps);
});

test("applyPaintOverride: an empty override leaves base ops unchanged", () => {
  expect(applyPaintOverride(baseOps, {})).toEqual(baseOps);
});

test("applyPaintOverride: overrides only the fields it sets", () => {
  const out = applyPaintOverride(baseOps, { color: "Purple" });
  expect(out.color).toBe("Purple");
  expect(out.title).toBe("#12080 Fix navbar"); // untouched
  expect(out.description).toBe("pr-watch"); // untouched
});

test("applyPaintOverride: explicit null clears a field (color -> none)", () => {
  const out = applyPaintOverride(baseOps, { color: null });
  expect(out.color).toBeNull();
});

test("applyPaintOverride: title never nulls (a tab must have a name)", () => {
  const out = applyPaintOverride(baseOps, { title: "control" });
  expect(out.title).toBe("control");
});

test("applyPaintOverride: can set a custom status pill", () => {
  const out = applyPaintOverride(baseOps, { statusPill: { key: "k", label: "building" } });
  expect(out.statusPill?.label).toBe("building");
});
