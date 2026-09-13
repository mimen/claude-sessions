import { expect, test } from "bun:test";
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
  return { generatedAt: "2026-09-13T05:03:55Z", observations, adapters: [] };
}
function budgetValues(output: string): string[] {
  return output.split("\n").filter(line => /(?:Fable|Opus) budget/.test(line))
    .map(line => line.trim().replace(/\s+/g, " ").split(" in ")[0]!);
}

test("the 50/50 budget uses each account's weekly and Fable readings separately", () => {
  const input = snapshot([
    reading("claude-max:personal", 48), reading("claude-max:personal#Fable", 95),
    reading("claude-max:auf", 83), reading("claude-max:auf#Fable", 100),
  ]);
  const original = JSON.stringify(input);
  const out = renderSnapshot(input);
  expect(budgetValues(out)).toEqual([
    "Fable budget ████████ 95%", "Opus budget ░░░░░░░░ 1%",
    "Fable budget ████████ 100%", "Opus budget █████░░░ 66%",
  ]);
  expect(out).toContain("Claude · personal");
  expect(out).toContain("Claude · auf");
  expect(out).toMatch(/weekly\s+████░░░░\s+48%/);
  expect(out).toMatch(/weekly\s+███████░\s+83%/);
  expect(out).toContain("50/50 allocation model; Opus is estimated.");
  expect(JSON.stringify(input)).toBe(original);
});

test("Opus can exceed its allocation without clipping the number or applying red", () => {
  const out = renderSnapshot(snapshot([
    reading("claude-max:personal", 85), reading("claude-max:personal#Fable", 50),
  ]));
  expect(budgetValues(out)).toEqual(["Fable budget ████░░░░ 50%", "Opus budget ████████ 120%"]);
  const opus = out.split("\n").find(line => line.includes("Opus budget"));
  expect(opus).not.toContain("\x1b[");
});

test("a missing Fable reading cannot be filled from another account", () => {
  const out = renderSnapshot(snapshot([
    reading("claude-max:personal", 55), reading("claude-max:auf", 65), reading("claude-max:auf#Fable", 100),
  ]));
  expect(budgetValues(out)).toEqual([
    "Fable budget unknown (Fable reading unavailable)", "Opus budget unknown (Fable reading unavailable)",
    "Fable budget ████████ 100%", "Opus budget ██░░░░░░ 30%",
  ]);
});

test("different reset periods cannot produce an Opus estimate", () => {
  const out = renderSnapshot(snapshot([
    reading("claude-max:personal", 60),
    reading("claude-max:personal#Fable", 80, { resetsAt: "2099-01-02T00:00:00Z" }),
  ]));
  expect(budgetValues(out)[1]).toBe("Opus budget unknown (reset windows differ)");
});

test("sub-second reset differences do not break the account pairing", () => {
  const out = renderSnapshot(snapshot([
    reading("claude-max:personal", 48, { resetsAt: "2099-01-01T00:00:00.600268Z" }),
    reading("claude-max:personal#Fable", 95, { resetsAt: "2099-01-01T00:00:00.600457Z" }),
  ]));
  expect(budgetValues(out)[1]).toBe("Opus budget ░░░░░░░░ 1%");
});

test("zero Fable usage with no active Fable reset still permits a budget", () => {
  const out = renderSnapshot(snapshot([
    reading("claude-max:personal", 18), reading("claude-max:personal#Fable", 0, { resetsAt: null }),
  ]));
  expect(budgetValues(out)).toEqual(["Fable budget ░░░░░░░░ 0%", "Opus budget ███░░░░░ 36%"]);
});

test("nonzero Fable usage without a reset is not treated as a matching window", () => {
  const out = renderSnapshot(snapshot([
    reading("claude-max:personal", 48), reading("claude-max:personal#Fable", 95, { resetsAt: null }),
  ]));
  expect(budgetValues(out)[1]).toBe("Opus budget unknown (reset windows differ)");
});

test("incompatible 50/50 readings do not silently become zero Opus usage", () => {
  const out = renderSnapshot(snapshot([
    reading("claude-max:personal", 10), reading("claude-max:personal#Fable", 90),
  ]));
  expect(budgetValues(out)[1]).toBe("Opus budget unknown (inconsistent 50/50 readings)");
});

test("mixed observation times cannot produce an Opus estimate", () => {
  const out = renderSnapshot(snapshot([
    reading("claude-max:personal", 48),
    reading("claude-max:personal#Fable", 95, { observedAt: "2026-09-12T05:03:55Z" }),
  ]));
  expect(budgetValues(out)[1]).toBe("Opus budget unknown (observation times differ)");
});

test("cached observations are identified and do not drive a fresh Opus estimate", () => {
  const cached = { ...reading("claude-max:personal#Fable", 95), stale: true };
  const out = renderSnapshot(snapshot([reading("claude-max:personal", 48), cached]));
  expect(out).toMatch(/Fable budget.*95%.*cached/);
  expect(budgetValues(out)[1]).toBe("Opus budget unknown (cached readings)");
});

test("an explicit provider Opus cap remains distinct from the calculated Opus budget", () => {
  const out = renderSnapshot(snapshot([
    reading("claude-max:personal", 55), reading("claude-max:personal#Fable", 80),
    reading("claude-max:personal#Opus", 20),
  ]));
  expect(out).toMatch(/Opus\s+██░░░░░░\s+20%/);
  expect(budgetValues(out)[1]).toBe("Opus budget ██░░░░░░ 30%");
});

test("other providers' Fable-named rows are unchanged", () => {
  const out = renderSnapshot(snapshot([
    reading("codex-pro#Fable", 95, { provider: "codex" }),
  ]));
  expect(budgetValues(out)).toEqual([]);
  expect(out).toMatch(/Fable\s+████████\s+95%/);
  expect(out).not.toContain("50/50");
});
