import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { parseWhamUsage, readLiveCodexAccounts } from "./codex-oauth.ts";

function usageOf(entry: { usage?: unknown }) {
  return entry.usage as {
    updatedAt: string;
    identity: { accountEmail: string; loginMethod?: string };
    primary?: { usedPercent: number; resetsAt: string | null; windowMinutes: number | null };
    secondary?: { usedPercent: number; resetsAt: string | null; windowMinutes: number | null };
  };
}

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

test("readLiveCodexAccounts keeps enabled codex files and retries 401 only after the token changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-codex-oauth-"));
  const proDir = join(root, "pro");
  const plusDir = join(root, "plus");
  mkdirSync(proDir);
  mkdirSync(plusDir);
  const proFile = join(proDir, "codex-pro.json");
  writeFileSync(proFile, JSON.stringify({
    type: "codex",
    disabled: false,
    email: "miladmaaan@gmail.com",
    account_id: "acct-pro",
    access_token: "oldtok",
  }));
  writeFileSync(join(plusDir, "codex-plus.json"), JSON.stringify({
    type: "codex",
    disabled: false,
    email: "milad@theafternoonumbrellafriends.com",
    account_id: "acct-plus",
    access_token: "plustok",
  }));
  writeFileSync(join(proDir, "claude.json"), JSON.stringify({
    type: "claude",
    disabled: false,
    email: "skip@example.com",
    access_token: "not-codex",
  }));
  writeFileSync(join(plusDir, "disabled.json"), JSON.stringify({
    type: "codex",
    disabled: true,
    email: "disabled@example.com",
    account_id: "acct-off",
    access_token: "offtok",
  }));

  const calls: Array<{ token: string; account: string }> = [];
  const fetchMock = async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const token = (headers.get("Authorization") ?? "").replace("Bearer ", "");
    const account = headers.get("ChatGPT-Account-Id") ?? "";
    calls.push({ token, account });
    if (account === "acct-pro" && token === "oldtok") {
      writeFileSync(proFile, JSON.stringify({
        type: "codex",
        disabled: false,
        email: "miladmaaan@gmail.com",
        account_id: "acct-pro",
        access_token: "newtok",
      }));
      return new Response("unauthorized", { status: 401 });
    }
    if (account === "acct-pro" && token === "newtok") {
      return Response.json(proWham);
    }
    if (account === "acct-plus") {
      return Response.json(plusWham);
    }
    return new Response("nope", { status: 500 });
  };

  const live = await readLiveCodexAccounts({
    dirs: [proDir, plusDir],
    fetch: fetchMock,
    now: () => OBSERVED_AT,
  });

  expect(live.emails.sort()).toEqual([
    "milad@theafternoonumbrellafriends.com",
    "miladmaaan@gmail.com",
  ]);
  expect(live.failures).toEqual([]);
  expect(live.ok.map((entry) => usageOf(entry).identity.accountEmail).sort()).toEqual([
    "milad@theafternoonumbrellafriends.com",
    "miladmaaan@gmail.com",
  ]);
  expect(calls.filter((c) => c.account === "acct-pro").map((c) => c.token)).toEqual(["oldtok", "newtok"]);
  expect(usageOf(live.ok.find((e) => usageOf(e).identity.loginMethod === "pro")!).secondary).toBeUndefined();
});
