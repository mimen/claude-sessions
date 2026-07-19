import { expect, test } from "bun:test";
import { renderStatusline, osc8, DEFAULT_STALENESS_MS } from "./render-statusline.ts";
import type { CatalogueRow } from "./db.ts";

const NOW = Date.parse("2026-07-10T12:00:00Z");

function row(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "s1", resumeId: null, customTitle: null, kind: "session",
    completed: false, archived: false, parkedTaskId: null, key: null,
    parentSessionId: null, role: null, resumeCommand: null, project: null,
    cluster: "pr-watch", gusWork: null, workUnitId: null, groupingId: null, statusLine: null, meta: {}, stage: null, notes: null,
    updatedAt: "2026-07-10T11:59:00Z", // fresh by default
    prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null,
    ...over,
  };
}

test("renders state pill label + clickable PR link + title", () => {
  const line = renderStatusline(
    row({ prNumber: 12080, prRepo: "heroku/dashboard", customTitle: "Fix navbar" }),
    { nowMs: NOW, statePill: { label: "in review", color: "#bf5af2" } },
  );
  expect(line).toContain("in review");
  expect(line).toContain("#12080 Fix navbar");
  expect(line).toContain(osc8("https://github.com/heroku/dashboard/pull/12080", "#12080 Fix navbar"));
});

test("state pill is colored with 24-bit ANSI when hex is present", () => {
  const line = renderStatusline(
    row({ prNumber: 1, prRepo: "a/b" }),
    { nowMs: NOW, statePill: { label: "approved", color: "#30d158" } },
  );
  // 48=100=63*2/(...) — check the exact 24-bit sequence for #30d158 → 48;209;88
  expect(line).toContain("\x1b[38;2;48;209;88mapproved\x1b[39m");
});

test("state pill without a color renders label plain", () => {
  const line = renderStatusline(
    row({ prNumber: 1, prRepo: "a/b" }),
    { nowMs: NOW, statePill: { label: "in review" } },
  );
  expect(line).toContain("in review");
  expect(line).not.toContain("\x1b[38;2;");
});

test("strips a leading #num already baked into the title (no double PR#)", () => {
  const line = renderStatusline(
    row({ prNumber: 12080, prRepo: "heroku/dashboard", customTitle: "#12080 Fix navbar" }),
    { nowMs: NOW, statePill: { label: "building", color: "#32ade6" } },
  );
  expect(line.match(/#12080/g)?.length).toBe(1);
});

test("adds the grouping label (linked) and W-number when both present", () => {
  const grouping = { label: "Metered Pricing", url: "https://gus/epic" };
  const line = renderStatusline(
    row({ prNumber: 12080, prRepo: "heroku/dashboard", gusWork: "W-23392849" }),
    { nowMs: NOW, grouping, statePill: { label: "approved", color: "#30d158" } },
  );
  expect(line).toContain("Metered Pricing");
  expect(line).toContain("W-23392849");
  expect(line).toContain(osc8("https://gus/epic", "Metered Pricing"));
});

test("strips a [Team] prefix from the grouping label", () => {
  const line = renderStatusline(
    row({ prNumber: 5, prRepo: "a/b" }),
    { nowMs: NOW, grouping: { label: "[Heroku] Metered Pricing", url: null } },
  );
  expect(line).toContain("Metered Pricing");
  expect(line).not.toContain("[Heroku]");
});

test("a W-only session (no PR) uses the W-number as the label, not a trailing dup", () => {
  const line = renderStatusline(row({ gusWork: "W-23392849" }), { nowMs: NOW });
  expect(line.match(/W-23392849/g)?.length).toBe(1);
  expect(line).toContain("W-23392849");
});

test("a stale row drops the state pill (never asserts an old value)", () => {
  const stale = row({
    prNumber: 12080, prRepo: "heroku/dashboard",
    updatedAt: new Date(NOW - DEFAULT_STALENESS_MS - 1000).toISOString(),
  });
  const line = renderStatusline(stale, { nowMs: NOW, statePill: { label: "merged", color: "#34c759" } });
  expect(line).not.toContain("merged"); // the stale pill is NOT shown
  expect(line).not.toContain("\x1b[38;2;");
});

test("a fresh row within the window keeps its state pill", () => {
  const line = renderStatusline(
    row({ prNumber: 1, prRepo: "a/b", updatedAt: new Date(NOW - 1000).toISOString() }),
    { nowMs: NOW, statePill: { label: "merged", color: "#34c759" } },
  );
  expect(line).toContain("merged");
});

test("no pill + fresh row: link only, no leading pill separator", () => {
  const line = renderStatusline(row({ prNumber: 5, prRepo: "a/b" }), { nowMs: NOW });
  expect(line.startsWith(" · ")).toBe(false);
  expect(line).toContain("#5");
});

test("a bare row with no PR/work reads as the neutral 'PR' label", () => {
  const line = renderStatusline(row({}), {
    nowMs: NOW, statePill: { label: "building", color: "#32ade6" },
  });
  expect(line).toContain("PR");
});
