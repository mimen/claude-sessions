import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildView } from "../../packages/usage-view/index.ts";
import { collectSnapshot } from "./adapters.ts";
import { readHubSnapshot, readHubToken, type HubCredential, type HubRead, type HubSnapshot } from "./hub.ts";
import { renderSnapshot } from "./render.ts";

const NOW = Date.parse("2026-10-02T22:00:00Z");

// Credentials as the hub's GET /gateway returned them on 2026-10-03, trimmed, plus the optional fields.
const base = {
  name: "x.json", authIndex: "i", disabled: false, priority: null, status: "active", statusMessage: null,
  unavailable: false, renewsAt: null, usageError: null, locked: false, usageObservedAt: NOW - 4 * 60_000,
} satisfies Partial<HubCredential>;

const claude: HubCredential = {
  ...base,
  provider: "claude",
  email: "personal@example.com",
  priority: 100,
  plan: "Max 20x",
  windows: {
    fiveHour: { usedPct: 10, resetsAt: "2026-10-02T23:00:00Z" },
    weekly: { usedPct: 35, resetsAt: "2026-10-06T21:00:00Z" },
    fable: { usedPct: 7, resetsAt: "2026-10-06T21:00:00Z" },
  },
  bankedResets: { count: 1, nextExpiresAt: "2026-10-22T19:00:00Z" },
};

const codexCred: HubCredential = {
  ...base,
  provider: "codex",
  email: "personal@example.com",
  plan: "Pro",
  renewsAt: "2026-10-20T19:33:49.000Z",
  renewsAtEstimated: true,
  windows: { fiveHour: null, weekly: { usedPct: 10, resetsAt: "2026-10-09T21:12:59.000Z" }, fable: null },
  bankedResets: {
    count: 3,
    nextExpiresAt: "2026-10-05T04:18:28Z",
    expiries: ["2026-10-05T04:18:28Z", "2026-10-12T04:18:28Z", "2026-10-19T04:18:28Z"],
  },
};

const xai: HubCredential = {
  ...base,
  provider: "xai",
  email: "personal@example.com",
  plan: "Super Grok Plus",
  windows: { fiveHour: null, weekly: { usedPct: 12, resetsAt: "2026-10-09T04:02:36.963Z" }, fable: null },
  bankedResets: { count: 1, nextExpiresAt: "2026-10-30T00:00:00Z", expiries: ["2026-10-30T00:00:00Z"] },
  productUsage: [{ product: "GrokBuild", usedPct: 9 }, { product: "GrokChat", usedPct: 3 }],
  prepaidUsd: 0,
};

const hubWith = (collectedAt: number, credentials: HubCredential[], unreachable?: string) => async (): Promise<HubRead> =>
  ({ ok: true, site: "http://hub", snapshot: { collectedAt, credentials }, ...(unreachable ? { unreachable } : {}) });

/** Fails the test if anything in the process reaches for the network. */
let calls: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    throw new Error("network");
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const rows = (snap: Awaited<ReturnType<typeof collectSnapshot>>) =>
  snap.observations.map((o) => [o.entitlement, o.metric, o.window, o.used ?? o.remaining, o.stale ?? false]);

test("a fresh hub snapshot renders every provider from its credentials", async () => {
  const snap = await collectSnapshot({ hub: hubWith(NOW - 4 * 60_000, [claude, codexCred, xai]), now: () => NOW });
  expect(calls).toEqual([]);
  expect(rows(snap)).toEqual([
    ["codex-pro:personal@example.com", "allowance", "weekly", 10, false],
    ["codex-reset-credit:personal@example.com", "reset_credit", null, 1, false],
    ["codex-reset-credit:personal@example.com", "reset_credit", null, 1, false],
    ["codex-reset-credit:personal@example.com", "reset_credit", null, 1, false],
    ["claude-max:personal@example.com", "allowance", "five_hour", 10, false],
    ["claude-max:personal@example.com", "allowance", "weekly", 35, false],
    ["claude-max:personal@example.com#Fable", "allowance", "weekly", 7, false],
    ["claude-reset-credit:personal@example.com", "reset_credit", null, 1, false],
    ["grok-super grok plus:personal@example.com", "allowance", "weekly", 12, false],
    ["grok-super grok plus:personal@example.com#build", "allowance", "weekly", 9, false],
    ["grok-super grok plus:personal@example.com#chat", "allowance", "weekly", 3, false],
    ["grok-super grok plus:personal@example.com#reset", "reset_credit", null, 1, false],
    ["grok-super grok plus:personal@example.com#prepaid", "credit", null, 0, false],
  ]);
  expect(snap.adapters.map((a) => a.status)).toEqual(["ok", "ok", "ok"]);
});

test("a stale hub snapshot means no provider fetch and the stale marker shows", async () => {
  const collectedAt = NOW - 11 * 60_000;
  const snap = await collectSnapshot({
    providers: ["anthropic"],
    hub: hubWith(collectedAt, [{ ...claude, usageObservedAt: collectedAt }]),
    now: () => NOW,
  });
  expect(calls).toEqual([]);
  expect(snap.observations.every((o) => o.stale === true)).toBe(true);
  const section = buildView(snap).sections.find((s) => s.account === "personal@example.com")!;
  expect(section.staleSince).toBe(collectedAt);
  // The terminal ages stale rows against the wall clock, so only the marker is literal here.
  expect(renderSnapshot(snap)).toMatch(/weekly .* 35% .* · stale \d+[mhd]/);
});

test("hub unreachable means the cached snapshot renders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-hub-"));
  const cachePath = join(dir, "hub-gateway.json");
  const collectedAt = NOW - 45 * 60_000;
  const cached: HubSnapshot = { collectedAt, credentials: [{ ...claude, usageObservedAt: collectedAt }] };
  const good = async () => Response.json(cached);
  expect((await readHubSnapshot({ token: "t", fetch: good, cachePath })).ok).toBe(true);

  const down = async () => { throw new Error("connect ECONNREFUSED"); };
  const read = await readHubSnapshot({ token: "t", fetch: down, cachePath });
  expect(read).toEqual({ ok: true, site: "https://usable-gopher-567.convex.site", snapshot: cached, unreachable: "hub unreachable: connect ECONNREFUSED" });

  const snap = await collectSnapshot({ providers: ["anthropic"], hub: async () => read, now: () => NOW });
  expect(rows(snap)[1]).toEqual(["claude-max:personal@example.com", "allowance", "weekly", 35, true]);
  expect(buildView(snap).notes).toEqual([
    "Claude: hub unreachable: connect ECONNREFUSED; hub snapshot from 2026-10-02T21:15:00.000Z",
  ]);
  expect(calls).toEqual([]);
});

test("no hub and no cache leaves every provider unavailable with the reason", async () => {
  const read = await readHubSnapshot({ token: null, cachePath: join(mkdtempSync(join(tmpdir(), "ccs-hub-")), "none.json") });
  expect(read.ok).toBe(false);
  const snap = await collectSnapshot({ providers: ["grok"], hub: async () => read, now: () => NOW });
  expect(snap.adapters[0]!.status).toBe("unavailable");
  expect(snap.adapters[0]!.detail).toStartWith("no hub read token (");
});

test("every banked-reset expiry shows, falling back to the soonest when the list is absent", async () => {
  const snap = await collectSnapshot({
    providers: ["codex", "anthropic"],
    hub: hubWith(NOW - 60_000, [codexCred, { ...claude, bankedResets: { count: 2, nextExpiresAt: "2026-10-22T19:00:00Z" } }]),
    now: () => NOW,
  });
  expect(snap.observations.filter((o) => o.metric === "reset_credit").map((o) => [o.provider, o.expiresAt])).toEqual([
    ["codex", "2026-10-05T04:18:28Z"],
    ["codex", "2026-10-12T04:18:28Z"],
    ["codex", "2026-10-19T04:18:28Z"],
    ["anthropic", "2026-10-22T19:00:00Z"],
    ["anthropic", "2026-10-22T19:00:00Z"],
  ]);
});

test("an estimated renewal renders as estimated", async () => {
  // The renewal attaches to the configured Codex Pro subscription for this account.
  const codex = { ...codexCred, email: "miladmaaan@gmail.com" };
  const snap = await collectSnapshot({ providers: ["codex"], hub: hubWith(NOW - 60_000, [codex]), now: () => NOW });
  expect(renderSnapshot(snap)).toContain("Codex Pro · renews ~Oct 20, estimated");
  const exact = await collectSnapshot({ providers: ["codex"], hub: hubWith(NOW - 60_000, [{ ...codex, renewsAtEstimated: undefined }]), now: () => NOW });
  expect(renderSnapshot(exact)).toContain("Codex Pro · renews Oct 20\n");
});

test("Grok's product shares fold into the pool bar and prepaid hides when absent", async () => {
  const snap = await collectSnapshot({ providers: ["grok"], hub: hubWith(NOW - 60_000, [xai]), now: () => NOW });
  const grok = buildView(snap).sections[0]!;
  expect(grok.rows.map((r) => r.kind === "allowance" ? `${r.label} ${r.segments.map((s) => s.name).join("+")}` : r.label))
    .toEqual(["All usage Build+Chat", "Banked reset", "Extra credits"]);
  const none = await collectSnapshot({ providers: ["grok"], hub: hubWith(NOW - 60_000, [{ ...xai, prepaidUsd: undefined }]), now: () => NOW });
  expect(buildView(none).sections[0]!.rows.map((r) => r.label)).toEqual(["All usage", "Banked reset"]);
});

test("an account carried forward under 30 minutes shows the stale chip and no warning note", async () => {
  const carried = { ...claude, usageError: "HTTP 429", usageObservedAt: NOW - 12 * 60_000 };
  const snap = await collectSnapshot({ providers: ["anthropic"], hub: hubWith(NOW - 60_000, [carried]), now: () => NOW });
  const view = buildView(snap);
  expect(view.notes).toEqual([]);
  expect(view.sections[0]!.staleSince).toBe(NOW - 12 * 60_000);
});

test("an account carried forward past 30 minutes gets its warning note back", async () => {
  const carried = { ...claude, usageError: "HTTP 429", usageObservedAt: NOW - 31 * 60_000 };
  const snap = await collectSnapshot({ providers: ["anthropic"], hub: hubWith(NOW - 60_000, [carried]), now: () => NOW });
  expect(buildView(snap).notes).toEqual(["Claude: personal@example.com HTTP 429, numbers from 2026-10-02T21:29:00.000Z"]);
});

test("the gateway account list comes from the snapshot, with fill-first's pick marked", async () => {
  const work = { ...claude, email: "work@example.com", priority: 0 };
  const snap = await collectSnapshot({ providers: ["anthropic"], hub: hubWith(NOW - 60_000, [work, claude]), now: () => NOW });
  expect(snap.gateway).toEqual({ base: "http://hub", accounts: [
    { provider: "anthropic", email: "work@example.com", priority: 0, disabled: false, firstInLine: false },
    { provider: "anthropic", email: "personal@example.com", priority: 100, disabled: false, firstInLine: true },
  ] });
});

test("the token file wins over the environment", async () => {
  const home = mkdtempSync(join(tmpdir(), "ccs-home-"));
  mkdirSync(join(home, ".config/ccs"), { recursive: true });
  writeFileSync(join(home, ".config/ccs/hub-read-token"), "from-file\n", { mode: 0o600 });
  const prev = Bun.env.HUB_READ_TOKEN;
  Bun.env.HUB_READ_TOKEN = "from-env";
  try {
    expect(await readHubToken("read", home)).toBe("from-file");
    expect(await readHubToken("read", mkdtempSync(join(tmpdir(), "ccs-home-")))).toBe("from-env");
  } finally {
    if (prev === undefined) delete Bun.env.HUB_READ_TOKEN; else Bun.env.HUB_READ_TOKEN = prev;
  }
});
