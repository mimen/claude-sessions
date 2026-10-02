import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicAdapter, grokAdapter } from "./adapters.ts";
import { connectGateway, gatewayAccounts, gatewayBases, parseAuthFiles } from "./gateway.ts";

// Trimmed from the Mini's /v0/management/auth-files on 2026-10-02.
const authFiles = {
  files: [
    { auth_index: "058001bd8bc0d923", type: "claude", provider: "claude", email: "work@example.com",
      disabled: false, priority: 0, status: "active", unavailable: false, next_retry_after: null, status_message: "" },
    { auth_index: "e536583d5ca004bd", type: "claude", provider: "claude", email: "personal@example.com",
      disabled: false, priority: 100, status: "active", unavailable: false, next_retry_after: null, status_message: "" },
    { auth_index: "d963e91a8e7cd960", type: "codex", provider: "codex", email: "personal@example.com",
      disabled: false, priority: null, status: "active", unavailable: false, id_token: { chatgpt_account_id: "acct-1" } },
    { auth_index: "7710e62af63e6967", type: "xai", provider: "xai", email: "personal@example.com",
      disabled: false, priority: null, status: "active", unavailable: false },
  ],
};

const usage = {
  limits: [
    { kind: "session", percent: 12, resets_at: "2026-10-02T20:00:00+00:00", scope: null },
    { kind: "weekly_all", percent: 40, resets_at: "2026-10-06T21:00:00+00:00", scope: null },
  ],
};

const freshCache = () => mkdtempSync(join(tmpdir(), "ccs-usage-cache-"));

/** A management API that answers auth-files and api-call the way the gateway does. */
function fakeManagement(opts: { down?: string[]; usageStatus?: Record<string, number> } = {}) {
  const apiCalls: unknown[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (opts.down?.some((base) => u.startsWith(base))) throw new Error("connect ECONNREFUSED");
    if (u.endsWith("/auth-files")) return Response.json(authFiles);
    const body = JSON.parse(init!.body as string) as { auth_index: string; url: string };
    apiCalls.push(body);
    const status = opts.usageStatus?.[body.auth_index] ?? 200;
    const upstream = body.url.includes("/profile")
      ? { organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } }
      : usage;
    return Response.json({ status_code: status, header: {}, body: JSON.stringify(status === 200 ? upstream : { error: "x" }) });
  };
  return { fetch, apiCalls };
}

test("the configured base comes first, then the local standby, then the local door", () => {
  expect(gatewayBases({})).toEqual([
    "http://milads-mac-mini.taild31e9a.ts.net:8450",
    "http://127.0.0.1:8318",
    "http://127.0.0.1:8317",
  ]);
  expect(gatewayBases({ CLI_PROXY_MGMT_URL: "http://127.0.0.1:8317" })).toEqual(["http://127.0.0.1:8317", "http://127.0.0.1:8318"]);
});

test("an unreachable base falls through to the next one", async () => {
  const { fetch } = fakeManagement({ down: ["http://mini"] });
  const conn = await connectGateway({ bases: ["http://mini", "http://standby"], key: "k", fetch });
  expect(conn.ok && conn.gateway.base).toBe("http://standby");
});

test("no reachable base names every base it tried", async () => {
  const { fetch } = fakeManagement({ down: ["http://mini", "http://standby"] });
  const conn = await connectGateway({ bases: ["http://mini", "http://standby"], key: "k", fetch });
  expect(conn).toEqual({
    ok: false,
    detail: "gateway unreachable: http://mini connect ECONNREFUSED; http://standby connect ECONNREFUSED",
  });
});

test("the account list shows priority, disabled, and who fill-first picks", () => {
  const creds = parseAuthFiles(authFiles);
  expect(gatewayAccounts(creds, ["anthropic", "codex"])).toEqual([
    { provider: "anthropic", email: "work@example.com", priority: 0, disabled: false, firstInLine: false },
    { provider: "anthropic", email: "personal@example.com", priority: 100, disabled: false, firstInLine: true },
    { provider: "codex", email: "personal@example.com", priority: 0, disabled: false, firstInLine: true },
  ]);
  const personalOff = creds.map((c) => (c.authIndex === "e536583d5ca004bd" ? { ...c, disabled: true } : c));
  expect(gatewayAccounts(personalOff, ["anthropic"]).map((a) => [a.email, a.firstInLine])).toEqual([
    ["work@example.com", true],
    ["personal@example.com", false],
  ]);
});

test("every Claude credential's usage is read through api-call with the token left to the gateway", async () => {
  const { fetch, apiCalls } = fakeManagement();
  const conn = await connectGateway({ bases: ["http://gw"], key: "k", fetch });
  const result = await anthropicAdapter(conn, { dir: freshCache() });
  expect(result.health).toEqual({ provider: "anthropic", status: "ok", detail: null });
  expect(result.observations.map((o) => [o.entitlement, o.window, o.used, (o as { tier?: string }).tier])).toEqual([
    ["claude-max:work@example.com", "five_hour", 12, "Max 20x"],
    ["claude-max:work@example.com", "weekly", 40, "Max 20x"],
    ["claude-max:personal@example.com", "five_hour", 12, "Max 20x"],
    ["claude-max:personal@example.com", "weekly", 40, "Max 20x"],
  ]);
  expect(apiCalls[0]).toMatchObject({
    auth_index: "058001bd8bc0d923",
    method: "GET",
    url: "https://api.anthropic.com/api/oauth/usage?cedar_ember=1",
    header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" },
  });
});

test("one dead Claude credential degrades the adapter and is named", async () => {
  const { fetch } = fakeManagement({ usageStatus: { "058001bd8bc0d923": 401 } });
  const conn = await connectGateway({ bases: ["http://gw"], key: "k", fetch });
  const result = await anthropicAdapter(conn, { dir: freshCache() });
  expect(result.health).toEqual({
    provider: "anthropic",
    status: "degraded",
    detail: "work@example.com oauth usage?cedar_ember=1 HTTP 401",
    accounts: ["work@example.com"],
  });
  expect(result.observations).toHaveLength(2);
});

/** One Claude credential whose usage endpoint answers from a script, one response per call. */
function scriptedClaude(responses: { status: number; retryAfter?: string }[]) {
  const urls: string[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/auth-files")) return Response.json({ files: [authFiles.files[1]] });
    const body = JSON.parse(init!.body as string) as { url: string };
    urls.push(body.url);
    if (body.url.includes("/profile")) return Response.json({ status_code: 200, header: {}, body: "{}" });
    const next = responses.shift()!;
    const header = next.retryAfter ? { "Retry-After": [next.retryAfter] } : {};
    const upstream = next.status === 200
      ? { limits: usage.limits, cedar_ember: { eligible: true, grants: [{ label: "launch", resets_left: 1, ends_at: "2026-10-22T16:00:00+00:00" }] } }
      : { error: { type: "rate_limit_error" } };
    return Response.json({ status_code: next.status, header, body: JSON.stringify(upstream) });
  };
  return { fetch, usageCalls: () => urls.filter((u) => u.includes("/usage")).length };
}

const t0 = Date.parse("2026-10-02T18:00:00Z");
const rows = (r: Awaited<ReturnType<typeof anthropicAdapter>>) =>
  r.observations.map((o) => [o.metric, o.window, o.used, o.expiresAt, o.stale ?? false]);

test("a 429 after a good read keeps the last windows and banked reset, marked stale", async () => {
  const dir = freshCache();
  const { fetch } = scriptedClaude([{ status: 200 }, { status: 429 }]);
  const conn = await connectGateway({ bases: ["http://gw"], key: "k", fetch });
  const good = await anthropicAdapter(conn, { dir, now: () => t0 });
  const limited = await anthropicAdapter(conn, { dir, now: () => t0 + 3 * 60_000 });

  expect(rows(limited)).toEqual([
    ["allowance", "five_hour", 12, null, true],
    ["allowance", "weekly", 40, null, true],
    ["reset_credit", null, null, "2026-10-22T16:00:00+00:00", true],
  ]);
  expect(limited.observations.map((o) => o.observedAt)).toEqual(good.observations.map((o) => o.observedAt));
  expect(limited.health).toEqual({
    provider: "anthropic",
    status: "degraded",
    detail: "personal@example.com oauth usage?cedar_ember=1 HTTP 429",
    accounts: ["personal@example.com"],
  });
});

test("a read within two minutes of the last one is served from the cache without a call", async () => {
  const dir = freshCache();
  const { fetch, usageCalls } = scriptedClaude([{ status: 200 }, { status: 200 }]);
  const conn = await connectGateway({ bases: ["http://gw"], key: "k", fetch });
  await anthropicAdapter(conn, { dir, now: () => t0 });
  const again = await anthropicAdapter(conn, { dir, now: () => t0 + 60_000 });
  expect(usageCalls()).toBe(1);
  expect(again.health.status).toBe("ok");
  expect(rows(again)[1]).toEqual(["allowance", "weekly", 40, null, false]);
  await anthropicAdapter(conn, { dir, now: () => t0 + 2 * 60_000 });
  expect(usageCalls()).toBe(2);
});

test("Retry-After holds the account off the endpoint until it passes", async () => {
  const dir = freshCache();
  const { fetch, usageCalls } = scriptedClaude([{ status: 200 }, { status: 429, retryAfter: "600" }, { status: 200 }]);
  const conn = await connectGateway({ bases: ["http://gw"], key: "k", fetch });
  await anthropicAdapter(conn, { dir, now: () => t0 });
  await anthropicAdapter(conn, { dir, now: () => t0 + 3 * 60_000 });
  const held = await anthropicAdapter(conn, { dir, now: () => t0 + 8 * 60_000 });
  expect(usageCalls()).toBe(2);
  expect(held.health.detail).toBe("personal@example.com oauth usage?cedar_ember=1 HTTP 429, retry after 2026-10-02T18:13:00.000Z");
  expect(rows(held)[0]).toEqual(["allowance", "five_hour", 12, null, true]);
  const back = await anthropicAdapter(conn, { dir, now: () => t0 + 14 * 60_000 });
  expect(usageCalls()).toBe(3);
  expect(back.health.status).toBe("ok");
});

// Bodies as the gateway's api-call returned them on 2026-10-02, trimmed.
const grokBilling = {
  config: {
    currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-02T04:02:36Z", end: "2026-10-09T04:02:36Z" },
    creditUsagePercent: 1.0,
    productUsage: [{ product: "GrokBuild", usagePercent: 1.0 }],
    prepaidBalance: { val: 0 },
  },
};
const grokSubscriptions = {
  subscriptions: [{ tier: "SUBSCRIPTION_TIER_SUPER_GROK_PRO", status: "SUBSCRIPTION_STATUS_ACTIVE", billingPeriodEnd: "2026-10-21T18:10:21Z" }],
};
/** grpc-web-text: the data frame (one grant, the parser fixture in grok.test.ts) then the trailer, each base64 on its own. */
const grokResets =
  Buffer.from("00000000235221520d72657365745f66697874757265a20106089c80f3d306f20106089cbd96d506", "hex").toString("base64")
  + Buffer.from("800000000f677270632d7374617475733a300d0a", "hex").toString("base64");

test("Grok reads billing, plan, and reset grants through the gateway's xAI credential", async () => {
  const calls: { auth_index: string; method: string; url: string; header: Record<string, string>; data?: string }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/auth-files")) return Response.json(authFiles);
    const body = JSON.parse(init!.body as string);
    calls.push(body);
    const upstream = body.url.includes("/billing") ? JSON.stringify(grokBilling)
      : body.url.includes("/subscriptions") ? JSON.stringify(grokSubscriptions)
      : grokResets;
    return Response.json({ status_code: 200, header: {}, body: upstream });
  };
  const conn = await connectGateway({ bases: ["http://gw"], key: "k", fetch });
  const result = await grokAdapter(conn);

  expect(result.health).toEqual({ provider: "grok", status: "ok", detail: null });
  expect(result.observations.map((o) => [o.entitlement, o.metric, o.used ?? o.remaining, o.expiresAt])).toEqual([
    ["grok-super grok pro:personal@example.com", "allowance", 1, null],
    ["grok-super grok pro:personal@example.com#build", "allowance", 1, null],
    ["grok-super grok pro:personal@example.com#reset", "reset_credit", 1, "2026-09-12T18:49:00.000Z"],
    ["grok-super grok pro:personal@example.com#prepaid", "credit", 0, null],
  ]);
  expect(result.renewals).toEqual([{ provider: "grok", account: "personal@example.com", renewsOn: "2026-10-21", source: "official_api" }]);
  expect(calls.every((c) => c.auth_index === "7710e62af63e6967" && c.header.Authorization === "Bearer $TOKEN$")).toBe(true);
  expect(calls.find((c) => c.url.includes("GetRemainingResets"))).toMatchObject({ method: "POST", data: "AAAAAAA=" });
});
