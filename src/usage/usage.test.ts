import { test, expect } from "bun:test";
import { accountLabel } from "./adapters.ts";
import { renderSnapshot, shortReset } from "./render.ts";
import { usageCommand } from "./command.ts";
import type { AdapterHealth, UsageObservation, UsageSnapshot } from "./types.ts";

function obs(over: Partial<UsageObservation> = {}): UsageObservation {
  return {
    provider: "codex",
    entitlement: "codex-pro",
    metric: "allowance",
    scope: "account",
    window: "weekly",
    used: 89,
    limit: 100,
    remaining: 11,
    resetsAt: "2026-08-27T04:05:01Z",
    expiresAt: null,
    observedAt: "2026-08-22T02:00:00Z",
    source: "official_cli",
    exact: false,
    ...over,
  };
}

function snap(over: { observations?: UsageObservation[]; adapters?: AdapterHealth[] } = {}): UsageSnapshot {
  return {
    generatedAt: "2026-08-22T02:00:00Z",
    observations: over.observations ?? [],
    adapters: over.adapters ?? [],
  };
}

test("accountLabel prefers email, then login method, then unknown", () => {
  expect(accountLabel({ accountEmail: "a@b.c", loginMethod: "pro" })).toBe("a@b.c");
  expect(accountLabel({ loginMethod: "SuperGrok" })).toBe("SuperGrok");
  expect(accountLabel(undefined)).toBe("unknown");
});

test("shortReset renders a human date and falls back to the raw string", () => {
  expect(shortReset("2026-08-27T04:05:01Z")).not.toMatch(/Z$/);
  expect(shortReset("not-a-date")).toBe("not-a-date");
});

test("render puts exhausted and near-exhausted before available, expiring credits in ATTENTION", () => {
  const out = renderSnapshot(snap({
    observations: [
      obs({ used: 10 }), // healthy weekly
      obs({ used: 99, window: "five_hour" }), // exhausted
      obs({
        provider: "codex", entitlement: "codex-reset-credit", metric: "reset_credit",
        used: null, limit: null, remaining: 1, expiresAt: "2026-09-20T23:56:16Z", exact: true,
      }),
    ],
  }));
  const attentionIdx = out.indexOf("ATTENTION");
  const availableIdx = out.indexOf("AVAILABLE");
  expect(attentionIdx).toBeGreaterThanOrEqual(0);
  expect(availableIdx).toBeGreaterThan(attentionIdx);
  const attention = out.slice(attentionIdx, availableIdx);
  expect(attention).toContain("banked full reset");
  expect(attention).toContain("five-hour exhausted"); // exhausted window
});

test("render states unknown allowance plainly instead of inventing a percentage", () => {
  const out = renderSnapshot(snap({
    observations: [obs({ provider: "anthropic", entitlement: "claude-max-personal", used: null, limit: null, remaining: null, resetsAt: null })],
  }));
  expect(out).toContain("allowance unknown");
});

test("render lists unavailable adapters after the data sections", () => {
  const out = renderSnapshot(snap({
    observations: [obs({ used: 10 })],
    adapters: [{ provider: "venice", status: "unavailable", detail: "rate_limits HTTP 401" }],
  }));
  expect(out.indexOf("UNAVAILABLE")).toBeGreaterThan(out.indexOf("AVAILABLE"));
  expect(out).toContain("rate_limits HTTP 401");
});

test("usageCommand rejects an unknown provider id", async () => {
  expect(await usageCommand(["--provider", "nope"])).toBe(1);
});

test("usageCommand sources prints the provenance table and exits 0", () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (m: string) => logs.push(m);
  try {
    const code = usageCommand(["sources"]);
    expect(code).toBe(0);
  } finally {
    console.log = orig;
  }
  expect(logs.join("\n")).toContain("official_api");
  expect(logs.join("\n")).toContain("venice");
});
