import { expect, test } from "bun:test";
import { claudeBudgets } from "./claude-budgets.ts";
import { renderSnapshot } from "./render.ts";
import type { UsageObservation, UsageSnapshot } from "./types.ts";

const reset = "2099-01-01T00:00:00Z";
function reading(entitlement: string, used: number | null, extra: Partial<UsageObservation> = {}): UsageObservation {
  return {
    provider: "anthropic", entitlement, metric: "allowance", scope: "account", window: "weekly",
    used, limit: 100, remaining: used === null ? null : Math.max(0, 100 - used),
    resetsAt: reset, expiresAt: null, observedAt: "2026-09-13T05:03:55Z",
    source: "official_api", exact: true, ...extra,
  };
}
function snapshot(observations: UsageObservation[]): UsageSnapshot {
  return { generatedAt: "2026-09-13T05:03:55Z", observations, adapters: [], subscriptions: [] };
}
/** Budget rows with the live countdown dropped, so assertions do not move with the clock. */
function budgetLines(output: string): string[] {
  return output.split("\n").filter(line => /budget/.test(line)).map(line => {
    const [head, ...notes] = line.trim().replace(/\s+/g, " ").split(" · ");
    return [head!.split(" in ")[0]!, ...notes].join(" · ");
  });
}

test("the Fable cap binds when it is the fuller meter", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", 48), reading("claude-max:personal#Fable", 95),
  ])).toEqual([
    { name: "Fable budget", usage: { kind: "known", usedPct: 95, resetsAt: reset, cached: false, binding: "own-cap" } },
    { name: "Non-Fable budget", usage: { kind: "known", usedPct: 48, resetsAt: reset, cached: false, binding: "shared-pool" } },
  ]);
});

test("the shared weekly pool binds the Fable budget once it passes the Fable cap", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", 93), reading("claude-max:personal#Fable", 40),
  ])).toEqual([
    { name: "Fable budget", usage: { kind: "known", usedPct: 93, resetsAt: reset, cached: false, binding: "shared-pool" } },
    { name: "Non-Fable budget", usage: { kind: "known", usedPct: 93, resetsAt: reset, cached: false, binding: "shared-pool" } },
  ]);
});

test("a weekly pool fuller than the Fable cap never reports above either meter", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", 85), reading("claude-max:personal#Fable", 50),
  ])).toEqual([
    { name: "Fable budget", usage: { kind: "known", usedPct: 85, resetsAt: reset, cached: false, binding: "shared-pool" } },
    { name: "Non-Fable budget", usage: { kind: "known", usedPct: 85, resetsAt: reset, cached: false, binding: "shared-pool" } },
  ]);
});

test("a nearly spent Fable cap over an empty weekly pool is an ordinary reading", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", 10), reading("claude-max:personal#Fable", 90),
  ])).toEqual([
    { name: "Fable budget", usage: { kind: "known", usedPct: 90, resetsAt: reset, cached: false, binding: "own-cap" } },
    { name: "Non-Fable budget", usage: { kind: "known", usedPct: 10, resetsAt: reset, cached: false, binding: "shared-pool" } },
  ]);
});

test("a missing Fable reading leaves the non-Fable budget intact", () => {
  expect(claudeBudgets([reading("claude-max:personal", 55)])).toEqual([
    { name: "Fable budget", usage: { kind: "unknown", reason: "Fable reading unavailable" } },
    { name: "Non-Fable budget", usage: { kind: "known", usedPct: 55, resetsAt: reset, cached: false, binding: "shared-pool" } },
  ]);
});

test("a missing weekly reading leaves both budgets unknown rather than zero", () => {
  expect(claudeBudgets([reading("claude-max:personal#Fable", 95)])).toEqual([
    { name: "Fable budget", usage: { kind: "unknown", reason: "weekly reading unavailable" } },
    { name: "Non-Fable budget", usage: { kind: "unknown", reason: "weekly reading unavailable" } },
  ]);
});

test("an unreadable weekly limit is unknown, not zero", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", null), reading("claude-max:personal#Fable", 95),
  ])).toEqual([
    { name: "Fable budget", usage: { kind: "unknown", reason: "weekly reading unavailable" } },
    { name: "Non-Fable budget", usage: { kind: "unknown", reason: "weekly reading unavailable" } },
  ]);
});

test("different reset periods cannot be compared against each other", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", 60),
    reading("claude-max:personal#Fable", 80, { resetsAt: "2099-01-02T00:00:00Z" }),
  ])).toEqual([
    { name: "Fable budget", usage: { kind: "unknown", reason: "reset windows differ" } },
    { name: "Non-Fable budget", usage: { kind: "known", usedPct: 60, resetsAt: reset, cached: false, binding: "shared-pool" } },
  ]);
});

test("sub-second reset differences do not break the account pairing", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", 48, { resetsAt: "2099-01-01T00:00:00.600268Z" }),
    reading("claude-max:personal#Fable", 95, { resetsAt: "2099-01-01T00:00:00.600457Z" }),
  ])[0]).toEqual({
    name: "Fable budget",
    usage: { kind: "known", usedPct: 95, resetsAt: "2099-01-01T00:00:00.600457Z", cached: false, binding: "own-cap" },
  });
});

test("zero Fable usage with no active Fable reset still permits a budget", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", 18), reading("claude-max:personal#Fable", 0, { resetsAt: null }),
  ])).toEqual([
    { name: "Fable budget", usage: { kind: "known", usedPct: 18, resetsAt: reset, cached: false, binding: "shared-pool" } },
    { name: "Non-Fable budget", usage: { kind: "known", usedPct: 18, resetsAt: reset, cached: false, binding: "shared-pool" } },
  ]);
});

test("nonzero Fable usage without a reset is not treated as a matching window", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", 48), reading("claude-max:personal#Fable", 95, { resetsAt: null }),
  ])[0]).toEqual({ name: "Fable budget", usage: { kind: "unknown", reason: "reset windows differ" } });
});

test("mixed observation times cannot be compared against each other", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", 48),
    reading("claude-max:personal#Fable", 95, { observedAt: "2026-09-12T05:03:55Z" }),
  ])[0]).toEqual({ name: "Fable budget", usage: { kind: "unknown", reason: "observation times differ" } });
});

test("a cached reading carries its staleness into the budget it binds", () => {
  const stale = { ...reading("claude-max:personal#Fable", 95), stale: true };
  expect(claudeBudgets([reading("claude-max:personal", 48), stale])).toEqual([
    { name: "Fable budget", usage: { kind: "known", usedPct: 95, resetsAt: reset, cached: true, binding: "own-cap" } },
    { name: "Non-Fable budget", usage: { kind: "known", usedPct: 48, resetsAt: reset, cached: false, binding: "shared-pool" } },
  ]);
});

test("an explicit provider Opus cap row does not participate in the budgets", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", 55), reading("claude-max:personal#Fable", 80),
    reading("claude-max:personal#Opus", 20),
  ])).toEqual([
    { name: "Fable budget", usage: { kind: "known", usedPct: 80, resetsAt: reset, cached: false, binding: "own-cap" } },
    { name: "Non-Fable budget", usage: { kind: "known", usedPct: 55, resetsAt: reset, cached: false, binding: "shared-pool" } },
  ]);
});

test("a Fable row belonging to another account is not paired with this weekly row", () => {
  expect(claudeBudgets([
    reading("claude-max:personal", 55), reading("claude-max:auf#Fable", 80),
  ])).toEqual([]);
});

test("each account renders its own budgets and the nested model is named", () => {
  const input = snapshot([
    reading("claude-max:personal", 48), reading("claude-max:personal#Fable", 95),
    reading("claude-max:auf", 83), reading("claude-max:auf#Fable", 20),
  ]);
  const original = JSON.stringify(input);
  const out = renderSnapshot(input);
  expect(budgetLines(out)).toEqual([
    "Fable budget ████████ 95%",
    "Non-Fable budget ████░░░░ 48% · limited by the weekly pool",
    "Fable budget ███████░ 83% · limited by the weekly pool",
    "Non-Fable budget ███████░ 83% · limited by the weekly pool",
  ]);
  expect(out).toContain("Claude · personal");
  expect(out).toContain("Claude · auf");
  expect(out).toMatch(/weekly\s+████░░░░\s+48%/);
  expect(out).toContain("One weekly pool covers every model; the Fable cap nests inside it.");
  expect(JSON.stringify(input)).toBe(original);
});

test("a missing Fable reading cannot be filled from another account", () => {
  const out = renderSnapshot(snapshot([
    reading("claude-max:personal", 55), reading("claude-max:auf", 65), reading("claude-max:auf#Fable", 100),
  ]));
  expect(budgetLines(out)).toEqual([
    "Fable budget unknown (Fable reading unavailable)",
    "Non-Fable budget ████░░░░ 55% · limited by the weekly pool",
    "Fable budget ████████ 100%",
    "Non-Fable budget █████░░░ 65% · limited by the weekly pool",
  ]);
});

test("other providers' Fable-named rows are unchanged", () => {
  const out = renderSnapshot(snapshot([reading("codex-pro#Fable", 95, { provider: "codex" })]));
  expect(budgetLines(out)).toEqual([]);
  expect(out).toMatch(/Fable\s+████████\s+95%/);
});
