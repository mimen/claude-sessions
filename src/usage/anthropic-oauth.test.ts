import { test, expect } from "bun:test";
import { planFromProfile, planFromTier, windowsFromOauthUsage } from "./anthropic-oauth.ts";

// Trimmed from the live endpoint on 2026-09-05: the legacy nimbus_quill field
// reads 0 while the scoped Fable limit sits at 33.
const maxAccount = {
  five_hour: { utilization: 65, resets_at: "2026-09-05T23:00:00+00:00" },
  seven_day: { utilization: 18, resets_at: "2026-09-08T21:00:00+00:00" },
  nimbus_quill: { utilization: 0, resets_at: null },
  limits: [
    { kind: "session", percent: 65, resets_at: "2026-09-05T23:00:00+00:00", scope: null },
    { kind: "weekly_all", percent: 18, resets_at: "2026-09-08T21:00:00+00:00", scope: null },
    { kind: "weekly_scoped", percent: 33, resets_at: "2026-09-08T21:00:00+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null } },
  ],
};

test("windows come from the limits array, so Fable reads the scoped limit", () => {
  const windows = windowsFromOauthUsage(maxAccount);
  expect(windows.map((w) => [w.window, w.suffix, w.utilization])).toEqual([
    ["five_hour", "", 65],
    ["weekly", "", 18],
    ["weekly", "#Fable", 33],
  ]);
});

test("payloads without limits fall back to the legacy top-level fields", () => {
  const windows = windowsFromOauthUsage({
    five_hour: { utilization: 5, resets_at: null },
    seven_day: { utilization: 40, resets_at: null },
    nimbus_quill: { utilization: 12, resets_at: null },
  });
  expect(windows.map((w) => [w.suffix, w.utilization])).toEqual([["", 5], ["", 40], ["#Fable", 12]]);
});

test("plan follows the profile's organization, not the keychain's stamped tier", () => {
  const pro = { account: { has_claude_max: false, has_claude_pro: true },
                organization: { organization_type: "claude_pro", rate_limit_tier: "default_claude_ai" } };
  expect(planFromProfile(pro, "default_claude_max_20x")).toEqual({ name: "Pro", dollars: 20 });
  const max = { organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } };
  expect(planFromProfile(max, null)).toEqual({ name: "Max 20x", dollars: 200 });
  expect(planFromProfile(null, "default_claude_max_5x")).toEqual({ name: "Max 5x", dollars: 100 });
  expect(planFromTier("default_claude_ai")).toEqual({ name: "Pro", dollars: 20 });
});
