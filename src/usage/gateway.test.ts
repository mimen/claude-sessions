import { expect, test } from "bun:test";
import { anthropicAdapter } from "./adapters.ts";
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
  const result = await anthropicAdapter(conn);
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
  const result = await anthropicAdapter(conn);
  expect(result.health).toEqual({
    provider: "anthropic",
    status: "degraded",
    detail: "work@example.com oauth usage?cedar_ember=1 HTTP 401",
    accounts: ["work@example.com"],
  });
  expect(result.observations).toHaveLength(2);
});
