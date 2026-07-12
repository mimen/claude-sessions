import { expect, test } from "bun:test";
import { renderStatusline, osc8, DEFAULT_STALENESS_MS } from "./render-statusline.ts";
import type { CatalogueRow } from "./db.ts";

const NOW = Date.parse("2026-07-10T12:00:00Z");

function row(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "s1", resumeId: null, customTitle: null, kind: "session",
    completed: false, archived: false, parkedTaskId: null, event: null, key: null,
    parentSessionId: null, skill: null, role: null, resumeCommand: null, project: null,
    system: "pr-watch", gusWork: null, workUnitId: null, epicId: null, phase: null, statusLine: null, meta: {}, stage: null, activity: null, notes: null,
    updatedAt: "2026-07-10T11:59:00Z", // fresh by default
    prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null,
    ...over,
  };
}

test("renders phase dot + clickable PR link + title", () => {
  const line = renderStatusline(
    row({ prNumber: 12080, prRepo: "heroku/dashboard", customTitle: "Fix navbar", phase: "review" }),
    { nowMs: NOW },
  );
  expect(line).toContain("🟣"); // review dot
  expect(line).toContain("#12080 Fix navbar");
  expect(line).toContain(osc8("https://github.com/heroku/dashboard/pull/12080", "#12080 Fix navbar"));
});

test("strips a leading #num already baked into the title (no double PR#)", () => {
  const line = renderStatusline(
    row({ prNumber: 12080, prRepo: "heroku/dashboard", customTitle: "#12080 Fix navbar", phase: "building" }),
    { nowMs: NOW },
  );
  // '#12080' appears exactly once (not "#12080 #12080")
  expect(line.match(/#12080/g)?.length).toBe(1);
});

test("adds the grouping label (linked) and W-number when both present", () => {
  const grouping = { label: "Metered Pricing", url: "https://gus/epic" };
  const line = renderStatusline(
    row({ prNumber: 12080, prRepo: "heroku/dashboard", gusWork: "W-23392849", phase: "ready" }),
    { nowMs: NOW, grouping },
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
  const line = renderStatusline(row({ gusWork: "W-23392849", phase: "building" }), { nowMs: NOW });
  expect(line.match(/W-23392849/g)?.length).toBe(1);
  expect(line).toContain("W-23392849");
});

test("a stale row renders phase as unknown, never asserts the old value", () => {
  const stale = row({
    prNumber: 12080, prRepo: "heroku/dashboard", phase: "merged",
    updatedAt: new Date(NOW - DEFAULT_STALENESS_MS - 1000).toISOString(),
  });
  const line = renderStatusline(stale, { nowMs: NOW });
  expect(line).not.toContain("🟢"); // the stale 'merged' dot is NOT shown
  expect(line).toContain("⚫"); // unknown dot instead
});

test("a fresh row within the window keeps its phase", () => {
  const line = renderStatusline(
    row({ prNumber: 1, prRepo: "a/b", phase: "merged", updatedAt: new Date(NOW - 1000).toISOString() }),
    { nowMs: NOW },
  );
  expect(line).toContain("🟢");
});

test("no phase + fresh row: link only, no leading dot separator", () => {
  const line = renderStatusline(row({ prNumber: 5, prRepo: "a/b", phase: null }), { nowMs: NOW });
  expect(line.startsWith(" · ")).toBe(false);
  expect(line).toContain("#5");
});

test("a bare row with no PR/work reads as the neutral 'PR' label", () => {
  const line = renderStatusline(row({ phase: "building" }), { nowMs: NOW });
  expect(line).toContain("PR");
});
