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
  key: null,
  parentSessionId: null,
  role: null,
  resumeCommand: null,
  project: null,
  cluster: null,
  gusWork: null,
  workUnitId: null,
  groupingId: null, statusLine: null, meta: {}, stage: null, activity: null,
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

test("renderTab: worker description is epic-only — the identity key is NOT shown", () => {
  // The second line is JUST the epic; the key/project are noise the title already conveys.
  const r = row({
    key: "Q1-planning",
    cluster: "pr-watch",
    gusWork: "W-1234567",
    groupingId: null, statusLine: null, meta: {}, stage: null, activity: null,
  });
  const ops = renderTab(r, "session", { grouping: { label: "Metered Pricing" } });
  expect(ops.description).toBe("Metered Pricing"); // epic only — no key, no cluster
  expect(ops.description).not.toContain("Q1-planning");
});

test("renderTab: worker description does NOT include the project", () => {
  const r = row({ project: "ccs", gusWork: "W-1234567" });
  const ops = renderTab(r, "session", { grouping: { label: "Metered Pricing" } });
  expect(ops.description).toBe("Metered Pricing");
  expect(ops.description).not.toContain("ccs");
});

test("renderTab: worker description shows the grouping (epic) label", () => {
  const r = row({ cluster: "pr-watch", gusWork: "W-1234567", prNumber: 123, prRepo: "a/b" });
  const ops = renderTab(r, "session", { grouping: { label: "Metered Pricing", url: "https://gus/e1" } });
  expect(ops.description).toContain("Metered Pricing");
});

test("renderTab: worker description falls back to W-number when no grouping label", () => {
  const r = row({ cluster: "pr-watch", gusWork: "W-7654321" });
  const ops = renderTab(r, "session", {});
  expect(ops.description).toContain("W-7654321");
});

test("renderTab: grouping label has its [tag] prefix stripped", () => {
  const r = row({ cluster: "pr-watch" });
  const ops = renderTab(r, "session", { grouping: { label: "[FE] Metered Pricing" } });
  expect(ops.description).toContain("Metered Pricing");
  expect(ops.description).not.toContain("[FE]");
});

test("renderTab: stage pill shows the bare stage when dormant (no activity)", () => {
  const r = row({ stage: "building", activity: null, prNumber: 12136, prRepo: "heroku/dashboard" });
  const ops = renderTab(r, "session");
  expect(ops.statusPill?.label).toBe("building");
  expect(ops.statusPill?.icon).toBe("hammer");
  expect(ops.statusPill?.key).toBe("ccs_lifecycle"); // shares the lifecycle key → never stacks
});

test("renderTab: stage pill maps every stage", () => {
  expect(renderTab(row({ stage: "building" }), "session").statusPill?.label).toBe("building");
  expect(renderTab(row({ stage: "milad-review" }), "session").statusPill?.label).toBe("your review");
  expect(renderTab(row({ stage: "in-review" }), "session").statusPill?.label).toBe("in review");
  expect(renderTab(row({ stage: "approved" }), "session").statusPill?.label).toBe("approved");
  expect(renderTab(row({ stage: "merged" }), "session").statusPill?.label).toBe("merged");
});

test("renderTab: activity overlays the stage keeping the stage word (stage × activity)", () => {
  expect(renderTab(row({ stage: "in-review", activity: "fixing" }), "session").statusPill?.label).toBe("in review · fixing");
  expect(renderTab(row({ stage: "milad-review", activity: "needs-you" }), "session").statusPill?.label).toBe("your review · needs you");
  expect(renderTab(row({ stage: "approved", activity: "fixing" }), "session").statusPill?.color).toBe("#ff6f22"); // fixing color wins
});

test("renderTab: no stage → falls back to lifecycle pill (parked)", () => {
  const r = row({ parkedTaskId: "T-1" });
  const ops = renderTab(r, "session");
  expect(ops.statusPill?.label).toBe("parked");
});

test("renderTab: loop description drops the redundant system (title carries the cluster now)", () => {
  const r = row({ kind: "loop", role: "control", cluster: "pr-watch" });
  const ops = renderTab(r, "loop");
  expect(ops.description).toBeNull(); // was "pr-watch"; now empty (no distinguishing key)
});

test("renderTab: loop uses role or custom title", () => {
  const loopWithRole = row({ kind: "loop", role: "pr-watch-2" });
  const ops1 = renderTab(loopWithRole, "loop");
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

test("renderTab: workers carry NO sidebar color (the phase pill owns state)", () => {
  // Whatever the PR/lifecycle state, a worker tab is color-neutral — state shows in the pill.
  expect(renderTab(row({ prNumber: 1, prState: "open" }), "session").color).toBeNull();
  expect(renderTab(row({ prNumber: 1, prState: "merged" }), "session").color).toBeNull();
  expect(renderTab(row({ prNumber: 1, prState: "closed" }), "session").color).toBeNull();
  expect(renderTab(row({ archived: true }), "session").color).toBeNull();
});

test("renderTab: worker description drops the redundant cluster name (system)", () => {
  const r = row({ cluster: "pr-watch", gusWork: "W-1", prNumber: 1 });
  const ops = renderTab(r, "session");
  expect(ops.description).not.toContain("pr-watch"); // cluster is noise; epic/W is the anchor
});

test("renderTab: loop kind gets distinct color (Purple)", () => {
  const r = row({ kind: "loop", role: "event-watch" });
  const ops = renderTab(r, "loop");
  expect(ops.color).toBe("Purple");
});

test("renderTab: a freeform status line takes the description slot (loop)", () => {
  const r = row({ kind: "loop", role: "slack-scout", cluster: "pr-watch", statusLine: "@kenya asked about the token PR; no reply yet" });
  const ops = renderTab(r, "loop");
  expect(ops.description).toBe("@kenya asked about the token PR; no reply yet");
});

test("renderTab: a freeform status line overrides the worker's computed description", () => {
  const r = row({ cluster: "pr-watch", gusWork: "W-1", prNumber: 1, statusLine: "waiting on CI to go green" });
  const ops = renderTab(r, "session", { grouping: { label: "Metered Pricing" } });
  expect(ops.description).toBe("waiting on CI to go green"); // status wins over "Metered Pricing"
});

test("renderTab: empty/blank status line leaves the computed description", () => {
  const r = row({ kind: "loop", role: "control", cluster: "pr-watch", statusLine: "   " });
  const ops = renderTab(r, "loop");
  expect(ops.description).toBeNull(); // blank status ignored → computed (empty) description
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
