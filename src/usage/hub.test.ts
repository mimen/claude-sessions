import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildView } from "../../packages/usage-view/index.ts";
import { collectSnapshot } from "./adapters.ts";
import { connectGateway } from "./gateway.ts";
import type { HubCredential, HubRead } from "./hub.ts";

const NOW = Date.parse("2026-10-02T22:00:00Z");

// One credential as the hub's GET /gateway returned it on 2026-10-02, trimmed.
const claude: HubCredential = {
  name: "claude-personal@example.com.json",
  authIndex: "e536583d5ca004bd",
  provider: "claude",
  email: "personal@example.com",
  disabled: false,
  priority: 100,
  status: "active",
  statusMessage: null,
  unavailable: false,
  plan: "Max 20x",
  renewsAt: null,
  usageError: null,
  locked: false,
  windows: {
    fiveHour: { usedPct: 10, resetsAt: "2026-10-02T23:00:00Z" },
    weekly: { usedPct: 35, resetsAt: "2026-10-06T21:00:00Z" },
    fable: { usedPct: 7, resetsAt: "2026-10-06T21:00:00Z" },
  },
  bankedResets: { count: 1, nextExpiresAt: "2026-10-22T19:00:00Z" },
  usageObservedAt: NOW - 4 * 60_000,
};

const hubWith = (collectedAt: number, credentials: HubCredential[]) => async (): Promise<HubRead> =>
  ({ ok: true, site: "http://hub", snapshot: { collectedAt, credentials } });

/** A gateway that counts every upstream call it is asked to make. */
function countingGateway() {
  let calls = 0;
  const fetch = async (url: string | URL | Request) => {
    if (String(url).endsWith("/auth-files")) {
      return Response.json({ files: [{ auth_index: claude.authIndex, type: "claude", email: claude.email, status: "active" }] });
    }
    calls++;
    return Response.json({ status_code: 200, header: {}, body: JSON.stringify({ limits: [{ kind: "weekly_all", percent: 50, resets_at: null }] }) });
  };
  return { gateway: () => connectGateway({ bases: ["http://gw"], key: "k", fetch }), calls: () => calls };
}

const rows = (snap: Awaited<ReturnType<typeof collectSnapshot>>) =>
  snap.observations.map((o) => [o.entitlement, o.metric, o.window, o.used, o.observedAt, o.stale ?? false]);

test("a fresh hub snapshot answers with no upstream call", async () => {
  const gw = countingGateway();
  const snap = await collectSnapshot({ providers: ["anthropic"], hub: hubWith(NOW - 4 * 60_000, [claude]), gateway: gw.gateway, now: () => NOW });
  expect(gw.calls()).toBe(0);
  expect(rows(snap)).toEqual([
    ["claude-max:personal@example.com", "allowance", "five_hour", 10, "2026-10-02T21:56:00.000Z", false],
    ["claude-max:personal@example.com", "allowance", "weekly", 35, "2026-10-02T21:56:00.000Z", false],
    ["claude-max:personal@example.com#Fable", "allowance", "weekly", 7, "2026-10-02T21:56:00.000Z", false],
    ["claude-reset-credit:personal@example.com", "reset_credit", null, null, "2026-10-02T21:56:00.000Z", false],
  ]);
  expect(snap.adapters).toEqual([{ provider: "anthropic", status: "ok", detail: null }]);
  expect(snap.gateway?.accounts.map((a) => a.email)).toEqual(["personal@example.com"]);
});

test("a snapshot older than ten minutes falls back to the gateway", async () => {
  const gw = countingGateway();
  const snap = await collectSnapshot({
    providers: ["anthropic"],
    hub: hubWith(NOW - 11 * 60_000, [claude]),
    gateway: gw.gateway,
    now: () => NOW,
    cache: { dir: mkdtempSync(join(tmpdir(), "ccs-hub-")), now: () => NOW },
  });
  expect(gw.calls()).toBe(2);
  expect(snap.observations.map((o) => [o.window, o.used])).toEqual([["weekly", 50]]);
});

test("an unreachable hub falls back to the gateway", async () => {
  const gw = countingGateway();
  await collectSnapshot({
    providers: ["anthropic"],
    hub: async () => ({ ok: false, detail: "hub unreachable: timeout" }),
    gateway: gw.gateway,
    now: () => NOW,
    cache: { dir: mkdtempSync(join(tmpdir(), "ccs-hub-")), now: () => NOW },
  });
  expect(gw.calls()).toBe(2);
});

test("an account carried forward under 30 minutes shows the stale chip and no warning note", async () => {
  const carried = { ...claude, usageError: "HTTP 429", usageObservedAt: NOW - 12 * 60_000 };
  const snap = await collectSnapshot({ providers: ["anthropic"], hub: hubWith(NOW - 60_000, [carried]), gateway: countingGateway().gateway, now: () => NOW });
  const view = buildView(snap);
  expect(view.notes).toEqual([]);
  expect(view.sections[0]!.staleSince).toBe(NOW - 12 * 60_000);
});

test("an account carried forward past 30 minutes gets its warning note back", async () => {
  const carried = { ...claude, usageError: "HTTP 429", usageObservedAt: NOW - 31 * 60_000 };
  const snap = await collectSnapshot({ providers: ["anthropic"], hub: hubWith(NOW - 60_000, [carried]), gateway: countingGateway().gateway, now: () => NOW });
  expect(buildView(snap).notes).toEqual(["Claude: personal@example.com HTTP 429, numbers from 2026-10-02T21:29:00.000Z"]);
});
