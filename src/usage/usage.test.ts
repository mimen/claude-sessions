import { test, expect } from "bun:test";
import { accountLabel } from "./adapters.ts";
import { renderSnapshot, shortReset } from "./render.ts";
import { usageCommand } from "./command.ts";
import type { AdapterHealth, SubscriptionInfo, UsageObservation, UsageSnapshot } from "./types.ts";
import { windowFromCswap } from "./adapters.ts";
import { mergeSubscriptionRenewals, nextMonthlyRenewal, renewalDate, resolveSubscriptions } from "./subscriptions.ts";

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

function snap(over: { observations?: UsageObservation[]; adapters?: AdapterHealth[]; subscriptions?: SubscriptionInfo[] } = {}): UsageSnapshot {
  return {
    generatedAt: "2026-08-22T02:00:00Z",
    observations: over.observations ?? [],
    adapters: over.adapters ?? [],
    subscriptions: over.subscriptions ?? [],
  };
}

test("next monthly renewal uses the current anchor day or the next month", () => {
  expect(nextMonthlyRenewal("2026-09-21", new Date("2026-08-01T00:00:00Z"))).toBe("2026-09-21");
  expect(nextMonthlyRenewal("2026-02-05", new Date("2026-09-05T23:59:59Z"))).toBe("2026-09-05");
  expect(nextMonthlyRenewal("2026-02-05", new Date("2026-09-06T08:00:00Z"))).toBe("2026-10-05");
  expect(nextMonthlyRenewal("2024-01-31", new Date("2026-02-28T12:00:00Z"))).toBe("2026-02-28");
});

test("renewal uses the Los Angeles calendar date at the evening boundary", () => {
  expect(nextMonthlyRenewal("2026-09-21", new Date("2026-09-21T03:00:00Z"))).toBe("2026-09-21");
  expect(nextMonthlyRenewal("2026-09-21", new Date("2026-09-22T03:00:00Z"))).toBe("2026-09-21");
});

test("subscription resolver filters providers and keeps full account identities", () => {
  expect(resolveSubscriptions(["anthropic"], new Date("2026-09-13T00:00:00Z"))).toEqual([
    {
      provider: "anthropic", account: "miladmaaan@gmail.com", planName: "Max 20x",
      monthlyDollars: 200, renewsOn: "2026-10-10", source: "configured",
    },
    {
      provider: "anthropic", account: "milad@afternoonumbrellafriends.com", planName: "Max 20x",
      monthlyDollars: 200, renewsOn: "2026-10-08", source: "configured",
    },
  ]);
});

test("render attaches subscriptions by exact provider and full account", () => {
  const out = renderSnapshot(snap({
    observations: [
      obs({ provider: "anthropic", entitlement: "claude-max:miladmaaan@other.com" }),
      obs({ provider: "anthropic", entitlement: "claude-max:miladmaaan@gmail.com" }),
    ],
    subscriptions: resolveSubscriptions(["anthropic"], new Date("2026-09-13T00:00:00Z")),
  }));
  const wrongAccount = out.slice(out.indexOf("miladmaaan@other.com"), out.indexOf("Claude · miladmaaan@gmail.com\n"));
  expect(wrongAccount).not.toContain("Max 20x · renews");
  expect(out).toContain("Claude · miladmaaan@gmail.com\n  Max 20x · renews Oct 10");
  expect(out).toContain("Claude · milad@afternoonumbrellafriends.com\n  Max 20x · renews Oct 8");
});

test("verified renewals override configured fallbacks for the exact account", () => {
  const configured = resolveSubscriptions(["codex"], new Date("2026-09-14T12:00:00Z"));
  // Two Codex accounts are configured; only the named one may be overridden.
  expect(mergeSubscriptionRenewals(configured, [{
    provider: "codex",
    account: "miladmaaan@gmail.com",
    renewsOn: "2026-10-20",
    source: "official_ui",
  }])).toEqual([
    { ...configured[0]!, renewsOn: "2026-10-20", source: "official_ui" },
    configured[1]!,
  ]);
});

test("provider timestamps become Los Angeles subscription dates", () => {
  expect(renewalDate("2026-09-21T06:30:00Z")).toBe("2026-09-20");
  expect(renewalDate("not-a-date")).toBeNull();
});

test("accountLabel prefers email, then login method, then unknown", () => {
  expect(accountLabel({ accountEmail: "a@b.c", loginMethod: "pro" })).toBe("a@b.c");
  expect(accountLabel({ loginMethod: "SuperGrok" })).toBe("SuperGrok");
  expect(accountLabel(undefined)).toBe("unknown");
});

test("shortReset renders a human date and falls back to the raw string", () => {
  expect(shortReset("2026-08-27T04:05:01Z")).not.toMatch(/Z$/);
  expect(shortReset("not-a-date")).toBe("not-a-date");
});

test("row order is semantic and never changes with utilization", () => {
  const out = renderSnapshot(snap({
    observations: [
      obs({ used: 10, window: "weekly" }),
      obs({ used: 99, window: "five_hour" }),
      obs({ entitlement: "codex-pro#Fable", used: 96, window: "weekly" }),
      obs({
        provider: "codex", entitlement: "codex-reset-credit", metric: "reset_credit",
        used: null, limit: null, remaining: 1, expiresAt: "2026-09-20T23:56:16Z", exact: true,
      }),
    ],
  }));
  const lines = out.split("\n");
  const fiveHourIdx = lines.findIndex((l) => l.includes("five-hour"));
  const weeklyIdx = lines.findIndex((l) => l.includes("weekly"));
  const fableIdx = lines.findIndex((l) => l.includes("Fable"));
  const resetIdx = lines.findIndex((l) => l.includes("banked reset"));
  expect(fiveHourIdx).toBeGreaterThan(0);
  expect(weeklyIdx).toBeGreaterThan(fiveHourIdx);
  expect(fableIdx).toBeGreaterThan(weeklyIdx);
  expect(resetIdx).toBeGreaterThan(fableIdx);
});

test("Claude accounts preserve source order regardless of usage", () => {
  const out = renderSnapshot(snap({
    observations: [
      obs({ provider: "anthropic", entitlement: "claude-max:personal@example.com", used: 5 }),
      obs({ provider: "anthropic", entitlement: "claude-max:work@example.com", used: 99 }),
    ],
  }));
  expect(out.indexOf("personal@example.com")).toBeLessThan(out.indexOf("work@example.com"));
});

test("bars align: every bar row shares the same bar column offset", () => {
  const out = renderSnapshot(snap({
    observations: [
      obs({ entitlement: "claude-max:a@b.c", provider: "anthropic", used: 10, window: "weekly" }),
      obs({ entitlement: "claude-max:b@c.d", provider: "anthropic", used: 55, window: "five_hour" }),
    ],
  }));
  const offsets = out.split("\n")
    .filter((l) => l.includes("█") || l.includes("░"))
    .map((l) => l.indexOf("█") >= 0 ? l.indexOf("█") : l.indexOf("░"));
  expect(offsets.length).toBe(2);
  expect(new Set(offsets).size).toBe(1); // all bars start at the same column
});

test("render states unknown allowance plainly instead of inventing a percentage", () => {
  const out = renderSnapshot(snap({
    observations: [obs({ provider: "anthropic", entitlement: "claude-max-personal", used: null, limit: null, remaining: null, resetsAt: null })],
  }));
  expect(out).toContain("— unknown");
});

test("render lists unavailable adapters after the data sections", () => {
  const out = renderSnapshot(snap({
    observations: [obs({ used: 10 })],
    adapters: [{ provider: "grok", status: "unavailable", detail: "billing HTTP 401" }],
  }));
  expect(out.indexOf("unavailable")).toBeGreaterThan(out.indexOf("10%"));
  expect(out).toContain("Grok: billing HTTP 401");
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
  expect(logs.join("\n")).toContain("grok");
});

// --- Review-fix regressions ---

test("accountEntitlement suffixes multi-account entries with their email", async () => {
  const { accountEntitlement } = await import("./adapters.ts");
  const entry = {} as Parameters<typeof accountEntitlement>[2];
  expect(accountEntitlement("claude-max", { accountEmail: "a@b.c" }, entry)).toBe("claude-max:a@b.c");
  expect(accountEntitlement("claude-max", undefined, entry)).toBe("claude-max");
});

test("sourceClassFor maps codexbar entry sources to evidence classes", async () => {
  const { sourceClassFor } = await import("./codexbar.ts");
  expect(sourceClassFor("oauth")).toBe("official_api");
  expect(sourceClassFor("web")).toBe("official_ui");
  expect(sourceClassFor("cli")).toBe("official_cli");
  expect(sourceClassFor(undefined)).toBe("official_cli");
});

test("product breakdown rows show percentages without duplicate bars or reset countdowns", () => {
  const reset = new Date(Date.now() + 3_600_000).toISOString();
  const out = renderSnapshot(snap({
    observations: [
      obs({ provider: "grok", entitlement: "grok-super-grok-plus:a@b.c", used: 9, resetsAt: reset }),
      obs({ provider: "grok", entitlement: "grok-super-grok-plus:a@b.c#build", used: 9, resetsAt: reset }),
      obs({ provider: "grok", entitlement: "grok-super-grok-plus:a@b.c#chat", used: 0, resetsAt: reset }),
    ],
  }));
  expect(out).toContain("Build 9% · Chat 0%");
  expect(out.split("█").length - 1).toBe(1); // only the shared weekly pool has a bar
  expect(out.split("in ").length - 1).toBe(1); // one shared reset countdown
});

test("render labels Spark and multi-account groups distinctly", () => {
  const out = renderSnapshot(snap({
    observations: [
      obs({ entitlement: "codex-spark", used: 0, window: "five_hour" }),
      obs({ provider: "anthropic", entitlement: "claude-max:a@b.c", used: 10 }),
    ],
  }));
  expect(out).toContain("Spark ");
  expect(out).toContain("Claude · a@b.c"); // account in the group title
});

test("inactive CodexBar snapshots fill in accounts --all-accounts omits", async () => {
  const { inactiveCodexSnapshotObservations } = await import("./adapters.ts");
  const live = new Set(["milad@theafternoonumbrellafriends.com"]);
  const observations = inactiveCodexSnapshotObservations({
    records: [{
      id: "miladmaaan@gmail.com",
      sourceLabel: "oauth",
      credits: { remaining: 0, updatedAt: 811119956.169675 },
      snapshot: {
        identity: { accountEmail: "miladmaaan@gmail.com", loginMethod: "pro" },
        primary: null,
        secondary: { usedPercent: 75, resetsAt: 811498539, windowMinutes: 10080 },
        extraRateWindows: [{
          id: "codex-spark",
          title: "Codex Spark 5-hour",
          window: { usedPercent: 0, resetsAt: 811137953, windowMinutes: 300 },
        }],
        codexResetCredits: {
          credits: [{ status: "available", expires_at: 812866708.129 }],
          updatedAt: 811119954.594954,
        },
        updatedAt: 811119954.59497,
      },
    }],
  }, live);
  const weekly = observations.find((o) => o.window === "weekly");
  expect(weekly?.entitlement).toBe("codex-pro:miladmaaan@gmail.com");
  expect(weekly?.used).toBe(75);
  expect(weekly?.stale).toBe(true);
  expect(weekly?.resetsAt).toBe("2026-09-19T08:15:39.000Z");
  expect(observations.some((o) => o.entitlement.includes("theafternoon"))).toBe(false);
  expect(observations.some((o) => o.metric === "reset_credit" && o.remaining === 1)).toBe(true);
});

test("a live Codex email is not double-counted from the snapshot cache", async () => {
  const { inactiveCodexSnapshotObservations } = await import("./adapters.ts");
  const observations = inactiveCodexSnapshotObservations([{
    id: "milad@theafternoonumbrellafriends.com",
    snapshot: {
      identity: { accountEmail: "milad@theafternoonumbrellafriends.com", loginMethod: "plus" },
      secondary: { usedPercent: 2, resetsAt: 811498539, windowMinutes: 10080 },
      updatedAt: 811119954,
    },
  }], ["milad@theafternoonumbrellafriends.com"]);
  expect(observations).toEqual([]);
});

test("a cached cswap window is marked stale so it cannot pass for a live reading", () => {
  const cached = windowFromCswap({ pct: 96, resetsAt: null }, "2026-09-07T04:40:23Z", true) as
    | (ReturnType<typeof windowFromCswap> & { stale?: boolean })
    | null;
  // The dead account's 96% rendered identically to the live account's numbers because this
  // flag was accepted as a parameter and then dropped on the floor.
  expect(cached?.stale).toBe(true);
  expect(cached?.observedAt).toBe("2026-09-07T04:40:23Z");

  const liveRow = windowFromCswap({ pct: 5, resetsAt: null }, "2026-09-09T01:00:00Z", false) as
    | (ReturnType<typeof windowFromCswap> & { stale?: boolean })
    | null;
  expect(liveRow?.stale).toBe(false);
});
