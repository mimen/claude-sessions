import { expect, test } from "bun:test";
import { anthropicHealth } from "./adapters.ts";
import { describeGatewayIssue, gatewayIssues, parseGatewayClaudeCredentials } from "./gateway-claude-health.ts";

const listing = {
  files: [
    { provider: "claude", email: "work@example.com", status: "active", unavailable: false, disabled: false, priority: 100 },
    { provider: "claude", email: "personal@example.com", status: "error", status_message: "token expired", unavailable: true, disabled: true, priority: 0 },
    { provider: "codex", email: "personal@example.com", status: "active", unavailable: false, disabled: false },
  ],
};

test("only Claude rows are read from the gateway listing", () => {
  const rows = parseGatewayClaudeCredentials(listing);
  expect(rows.map((r) => r.email)).toEqual(["work@example.com", "personal@example.com"]);
  expect(rows[1]?.statusMessage).toBe("token expired");
});

test("a parked (disabled but healthy) credential is not an issue; a dead one is named with its cure", () => {
  const rows = parseGatewayClaudeCredentials(listing);
  expect(describeGatewayIssue({ ...rows[0]!, disabled: true })).toBeNull();
  expect(gatewayIssues(rows)).toEqual([
    { email: "personal@example.com", reason: "gateway: token expired (needs cliproxyapi -claude-login)" },
  ]);
  expect(describeGatewayIssue({ ...rows[0]!, nextRetryAfter: "2026-09-30T17:00:21-07:00" }))
    .toBe("gateway: cooling down until 2026-09-30T17:00:21-07:00");
});

test("health names both logins of a broken account and stays ok when both are fine", () => {
  expect(anthropicHealth(6, [], [])).toEqual({ provider: "anthropic", status: "ok", detail: null });
  const h = anthropicHealth(
    6,
    [{ email: "personal@example.com", status: "relogin_required" }],
    [{ email: "personal@example.com", reason: "gateway: token expired (needs cliproxyapi -claude-login)" }],
  );
  expect(h.status).toBe("degraded");
  expect(h.detail).toBe(
    "personal@example.com (relogin_required) on cached usage — re-auth via cswap; personal@example.com gateway: token expired (needs cliproxyapi -claude-login)",
  );
  expect(h.accounts).toEqual(["personal@example.com"]);
  // The unreachable-gateway case: no gateway rows, cswap fine -> ok, never a false alarm.
  expect(anthropicHealth(6, [], []).status).toBe("ok");
});
