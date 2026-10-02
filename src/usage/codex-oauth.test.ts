import { expect, test } from "bun:test";
import { parseWhamUsage, readLiveCodexAccounts, RESET_CREDITS_URL } from "./codex-oauth.ts";
import { parseAuthFiles, type Gateway } from "./gateway.ts";

function usageOf(entry: { usage?: unknown }) {
  return entry.usage as {
    updatedAt: string;
    identity: { accountEmail: string; loginMethod?: string };
    primary?: { usedPercent: number; resetsAt: string | null; windowMinutes: number | null };
    secondary?: { usedPercent: number; resetsAt: string | null; windowMinutes: number | null };
    codexResetCredits?: unknown;
  };
}

const proResetCredits = {
  credits: [
    {
      id: "RateLimitResetCredit_55525556c58c8191b5c994c222244231",
      reset_type: "codex_rate_limits",
      status: "available",
      granted_at: "2026-09-05T04:18:28.129844Z",
      expires_at: "2026-10-05T04:18:28.129844Z",
      redeemed_at: null,
      title: "Full reset",
    },
  ],
  available_count: 1,
};

const OBSERVED_AT = "2026-09-19T18:00:00.000Z";

const proWham = {
  plan_type: "pro",
  rate_limit: {
    primary_window: {
      used_percent: 0,
      reset_at: 1790410883,
      limit_window_seconds: 18_000,
    },
    secondary_window: null,
  },
  credits: { balance: 12.5 },
  rate_limit_reset_credits: { available_count: 0 },
};

const plusWham = {
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 0,
      reset_at: 1_789_884_168,
      limit_window_seconds: 18_000,
    },
    secondary_window: {
      used_percent: 18,
      reset_at: 1_790_323_554,
      limit_window_seconds: 604_800,
    },
  },
  credits: { balance: 0 },
  rate_limit_reset_credits: { available_count: 0 },
};

test("Pro maps nested primary window and omits a null secondary", () => {
  const entry = parseWhamUsage(proWham, { email: "miladmaaan@gmail.com" }, OBSERVED_AT);
  expect(entry.source).toBe("oauth");
  expect(usageOf(entry)).toEqual({
    updatedAt: OBSERVED_AT,
    identity: { accountEmail: "miladmaaan@gmail.com", loginMethod: "pro" },
    primary: {
      usedPercent: 0,
      resetsAt: "2026-09-26T08:21:23.000Z",
      windowMinutes: 300,
    },
  });
  expect(entry.credits).toEqual({ remaining: 12.5, updatedAt: OBSERVED_AT });
  expect(JSON.stringify(entry)).not.toMatch(/"resetsAt":\d/);
});

test("Plus maps nested primary and secondary unix reset_at to ISO", () => {
  const entry = parseWhamUsage(plusWham, { email: "milad@theafternoonumbrellafriends.com" }, OBSERVED_AT);
  const usage = usageOf(entry);
  expect(usage.identity).toEqual({
    accountEmail: "milad@theafternoonumbrellafriends.com",
    loginMethod: "plus",
  });
  expect(usage.primary).toEqual({
    usedPercent: 0,
    resetsAt: "2026-09-20T06:02:48.000Z",
    windowMinutes: 300,
  });
  expect(usage.secondary).toEqual({
    usedPercent: 18,
    resetsAt: "2026-09-25T08:05:54.000Z",
    windowMinutes: 10080,
  });
  expect(typeof usage.primary?.resetsAt).toBe("string");
  expect(typeof usage.secondary?.resetsAt).toBe("string");
  expect(JSON.stringify(entry)).not.toMatch(/"resetsAt":\d/);
});

test("readLiveCodexAccounts reads every gateway Codex credential through api-call", async () => {
  const calls: Array<{ authIndex: string; url: string; header: Record<string, string> }> = [];
  const gateway: Gateway = {
    base: "http://gw.test",
    credentials: parseAuthFiles({ files: [
      { auth_index: "pro", provider: "codex", email: "miladmaaan@gmail.com", id_token: { chatgpt_account_id: "acct-pro" } },
      { auth_index: "plus", provider: "codex", email: "milad@theafternoonumbrellafriends.com", id_token: { chatgpt_account_id: "acct-plus" } },
      { auth_index: "claude", provider: "claude", email: "skip@example.com" },
      { auth_index: "dead", provider: "codex", email: "dead@example.com" },
    ] }),
    async call(authIndex, url, header) {
      calls.push({ authIndex, url, header });
      if (authIndex === "dead") return { status: 401, body: null };
      if (url === RESET_CREDITS_URL) {
        return { status: 200, body: authIndex === "pro" ? proResetCredits : { credits: [], available_count: 0 } };
      }
      return { status: 200, body: authIndex === "pro" ? proWham : plusWham };
    },
  };

  const live = await readLiveCodexAccounts(gateway, { now: () => OBSERVED_AT });

  expect(live.emails).toEqual(["miladmaaan@gmail.com", "milad@theafternoonumbrellafriends.com"]);
  expect(live.failures).toEqual([{ email: "dead@example.com", detail: "HTTP 401" }]);
  expect(calls[0]).toEqual({
    authIndex: "pro",
    url: "https://chatgpt.com/backend-api/wham/usage",
    header: { Authorization: "Bearer $TOKEN$", Accept: "application/json", "ChatGPT-Account-Id": "acct-pro" },
  });
  const pro = usageOf(live.ok.find((e) => usageOf(e).identity.loginMethod === "pro")!);
  expect(pro.secondary).toBeUndefined();
  expect(pro.codexResetCredits).toEqual({
    availableCount: 1,
    credits: [{
      id: "RateLimitResetCredit_55525556c58c8191b5c994c222244231",
      status: "available",
      granted_at: "2026-09-05T04:18:28.129844Z",
      expires_at: "2026-10-05T04:18:28.129844Z",
      redeemed_at: null,
      title: "Full reset",
    }],
    updatedAt: OBSERVED_AT,
  });
  const plus = usageOf(live.ok.find((e) => usageOf(e).identity.loginMethod === "plus")!);
  expect(plus.codexResetCredits).toEqual({ availableCount: 0, credits: [], updatedAt: OBSERVED_AT });
});
