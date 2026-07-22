import { expect, test } from "bun:test";
import { renderStatusline, renderMeters, osc8, DEFAULT_STALENESS_MS } from "./render-statusline.ts";
import type { CatalogueRow } from "./db.ts";

const NOW = Date.parse("2026-07-10T12:00:00Z");

function row(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "s1", resumeId: null, customTitle: null, kind: "session",
    completed: false, archived: false, parkedTaskId: null, key: null,
    parentSessionId: null, role: null, resumeCommand: null, project: null,
    sessionClass: null,
    cluster: "pr-watch", gusWork: null, workUnitId: null, groupingId: null, statusLine: null, meta: {}, stage: null, notes: null,
    updatedAt: "2026-07-10T11:59:00Z", // fresh by default
    prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null, identityKey: null,
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
  expect(line.startsWith(" ")).toBe(false); // no leading separator gap
  expect(line).toContain("#5");
});

test("a bare row with no PR/work reads as the neutral 'PR' label", () => {
  const line = renderStatusline(row({}), {
    nowMs: NOW, statePill: { label: "building", color: "#32ade6" },
  });
  expect(line).toContain("PR");
});

// ── meters line (line 2) ───────────────────────────────────────────────────────────────────────

test("meters: model display_name is tinted with the ccs family color", () => {
  const line = renderMeters({ modelId: "claude-opus-4-8", modelLabel: "Opus 4.8" });
  // opus #c99a6b → 201;154;107
  expect(line).toContain("\x1b[38;2;201;154;107mOpus 4.8\x1b[39m");
});

test("meters: a gateway GPT model keeps its teal family color", () => {
  const line = renderMeters({ modelId: "gpt-5.6-sol-high", modelLabel: "GPT-5.6 Sol" });
  // sol #4fb3a9 → 79;179;169
  expect(line).toContain("\x1b[38;2;79;179;169mGPT-5.6 Sol\x1b[39m");
});

test("meters: falls back to the family short label when display_name is absent", () => {
  const line = renderMeters({ modelId: "claude-sonnet-5" });
  expect(line).toContain("sonnet");
});

test("meters: effort and fast-mode render together", () => {
  const line = renderMeters({ effort: "high", fast: true });
  expect(line).toContain("high");
  expect(line).toContain("⚡fast");
});

test("meters: context gauge shows a bar, the percent, and the window size", () => {
  const line = renderMeters({ ctxPercent: 42, ctxSize: 1_000_000 });
  expect(line).toContain("ctx");
  expect(line).toContain("█"); // gauge filled cells drawn
  expect(line).toContain("42%");
  expect(line).toContain("1M");
});

test("meters: a 200k window renders as 200k", () => {
  const line = renderMeters({ ctxPercent: 8, ctxSize: 200_000 });
  expect(line).toContain("200k");
});

test("meters: cost is graded by the ccs cost ramp", () => {
  const line = renderMeters({ costUsd: 1.23 });
  // $1–$100 → costLow #9aa3b2 → 154;163;178
  expect(line).toContain("\x1b[38;2;154;163;178m$1.23\x1b[39m");
});

test("meters: sub-dollar cost renders as cents", () => {
  const line = renderMeters({ costUsd: 0.5 });
  expect(line).toContain("50¢");
});

test("meters: empty input yields an empty line (identity-only session)", () => {
  expect(renderMeters({})).toBe("");
});

test("meters: null context percent omits the ctx bit (pre-first-response)", () => {
  const line = renderMeters({ ctxPercent: null, costUsd: 2 });
  expect(line).not.toContain("ctx");
  expect(line).toContain("$2.00");
});

test("meters: sections are separated by the wide gap, not a middot", () => {
  const line = renderMeters({ modelId: "claude-opus-4-8", modelLabel: "Opus 4.8", costUsd: 2 });
  expect(line).toContain("    "); // 4-space section gap
  expect(line).not.toContain("·");
});

test("meters: the context gauge is 16 cells wide", () => {
  const line = renderMeters({ ctxPercent: 42, ctxSize: 1_000_000 });
  const filled = (line.match(/█/g) ?? []).length;
  const empty = (line.match(/░/g) ?? []).length;
  expect(filled + empty).toBe(16);
  expect(filled).toBe(7); // round(0.42 * 16)
});

test("identity line also uses the wide gap (both rows stay consistent)", () => {
  const line = renderStatusline(
    row({ prNumber: 12080, prRepo: "heroku/dashboard", customTitle: "Fix navbar" }),
    { nowMs: NOW, statePill: { label: "in review", color: "#bf5af2" } },
  );
  expect(line).toContain("    ");
  expect(line).not.toContain(" · ");
});
