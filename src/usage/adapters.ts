/**
 * `ccs usage` from the hub's snapshot alone. The Mini's collector reads Anthropic, ChatGPT, and
 * xAI; this file only turns its credentials into observations, so no Mac ever calls a provider.
 * A snapshot older than HUB_FRESH_MS, or one served from this Mac's cache because the hub did not
 * answer, still renders, with every row marked stale.
 */

import type {
  AdapterHealth,
  GatewayAccount,
  ProviderId,
  SubscriptionRenewal,
  UsageObservation,
  UsageSnapshot,
  UsageWindow,
} from "./types.ts";
import { HUB_FRESH_MS, readHubSnapshot, type HubCredential, type HubRead, type HubSnapshot, type HubWindow } from "./hub.ts";
import { mergeSubscriptionRenewals, renewalDate, resolveSubscriptions } from "./subscriptions.ts";

export interface AdapterResult {
  observations: UsageObservation[];
  health: AdapterHealth;
  renewals?: SubscriptionRenewal[];
}

const PROVIDERS: readonly ProviderId[] = ["codex", "anthropic", "grok"];

/** Numbers stale for less than this show only their stale chip, not a warning note. */
export const QUIET_STALE_MS = 30 * 60_000;

/** What the hub calls each provider. */
const HUB_PROVIDER: Record<ProviderId, string> = { anthropic: "claude", codex: "codex", grok: "xai" };
const TITLE: Record<ProviderId, string> = { anthropic: "Claude", codex: "Codex", grok: "Grok" };

/** One ISO time per available reset: the full list when the hub sends it, else the soonest repeated. */
function resetExpiries(banked: HubCredential["bankedResets"]): (string | null)[] {
  if (!banked) return [];
  if (banked.expiries) return banked.expiries;
  return Array.from({ length: banked.count }, () => banked.nextExpiresAt);
}

/** Entitlement ids the usage view already knows how to label and group. */
function entitlements(provider: ProviderId, c: HubCredential & { email: string }) {
  if (provider === "grok") {
    const pool = `grok-${(c.plan ?? "consumer").toLowerCase()}:${c.email}`;
    return { pool, reset: `${pool}#reset`, product: (p: string) => `${pool}#${p.replace(/^Grok/, "").toLowerCase()}`, prepaid: `${pool}#prepaid` };
  }
  const pool = provider === "anthropic" ? `claude-max:${c.email}` : `codex-pro:${c.email}`;
  return { pool, reset: `${provider === "anthropic" ? "claude" : "codex"}-reset-credit:${c.email}`, product: (p: string) => `${pool}#${p}`, prepaid: null };
}

/**
 * One provider's rows from the snapshot. A credential is stale when the collector carried its
 * numbers forward (usageError) or when the whole snapshot is stale (`snapshotStale`).
 */
export function hubAdapter(provider: ProviderId, snapshot: HubSnapshot, nowMs: number, unreachable?: string): AdapterResult {
  const snapshotStale = unreachable !== undefined || nowMs - snapshot.collectedAt >= HUB_FRESH_MS;
  const observations: UsageObservation[] = [];
  const renewals: SubscriptionRenewal[] = [];
  const issues: { email: string; reason: string }[] = [];
  for (const raw of snapshot.credentials) {
    if (raw.provider !== HUB_PROVIDER[provider] || !raw.email || (provider === "grok" && raw.disabled)) continue;
    const c = raw as HubCredential & { email: string };
    const observedMs = c.usageObservedAt ?? (c.usageError ? null : snapshot.collectedAt);
    if (c.usageError && (observedMs === null || nowMs - observedMs >= QUIET_STALE_MS)) {
      issues.push({ email: c.email, reason: observedMs === null ? c.usageError : `${c.usageError}, numbers from ${new Date(observedMs).toISOString()}` });
    }
    const renewsOn = renewalDate(c.renewsAt);
    if (renewsOn) renewals.push({ provider, account: c.email, renewsOn, source: "official_api", ...(c.renewsAtEstimated ? { estimated: true } : {}) });
    if (observedMs === null) continue;

    const ids = entitlements(provider, c);
    const common = {
      provider,
      scope: provider === "grok" ? "organization" : "account",
      observedAt: new Date(observedMs).toISOString(),
      source: "official_api",
      ...(snapshotStale || c.usageError !== null ? { stale: true } : {}),
    } as const;
    const allowance = (entitlement: string, window: UsageWindow, w: HubWindow): UsageObservation => ({
      ...common,
      entitlement,
      metric: "allowance",
      window,
      used: w.usedPct,
      limit: 100,
      remaining: Math.max(0, 100 - w.usedPct),
      resetsAt: w.resetsAt,
      expiresAt: null,
      // Codex rounds its percentages; Anthropic and xAI report them as read.
      exact: provider !== "codex",
      ...(provider === "anthropic" ? { tier: c.plan } : {}),
    } as UsageObservation);

    const { fiveHour, weekly, fable } = c.windows;
    if (fiveHour) observations.push(allowance(ids.pool, "five_hour", fiveHour));
    if (weekly) observations.push(allowance(ids.pool, "weekly", weekly));
    if (fable) observations.push(allowance(ids.product("Fable"), "weekly", fable));
    for (const p of c.productUsage ?? []) {
      observations.push(allowance(ids.product(p.product), "weekly", { usedPct: p.usedPct, resetsAt: weekly?.resetsAt ?? null }));
    }
    for (const expiresAt of resetExpiries(c.bankedResets)) {
      observations.push({
        ...common, entitlement: ids.reset, metric: "reset_credit", window: null,
        used: null, limit: null, remaining: 1, resetsAt: null, expiresAt, exact: true,
      });
    }
    if (ids.prepaid && typeof c.prepaidUsd === "number") {
      observations.push({
        ...common, entitlement: ids.prepaid, metric: "credit", window: null,
        used: null, limit: null, remaining: c.prepaidUsd, resetsAt: null, expiresAt: null, exact: true,
      });
    }
  }
  const age = `hub snapshot from ${new Date(snapshot.collectedAt).toISOString()}`;
  if (observations.length > 0 && snapshotStale && nowMs - snapshot.collectedAt >= QUIET_STALE_MS) {
    issues.unshift({ email: "", reason: unreachable ? `${unreachable}; ${age}` : age });
  }
  const detail = issues.map((i) => (i.email ? `${i.email} ${i.reason}` : i.reason)).join("; ");
  const health: AdapterHealth = observations.length === 0
    ? { provider, status: "unavailable", detail: detail || `no ${TITLE[provider]} credentials in the hub snapshot` }
    : issues.length === 0
      ? { provider, status: "ok", detail: null }
      : { provider, status: "degraded", detail, ...(issues.some((i) => i.email) ? { accounts: issues.flatMap((i) => (i.email ? [i.email] : [])) } : {}) };
  return { observations, health, renewals };
}

/**
 * The gateway's routing view per provider, from the collector's copy of auth-files. Fill-first
 * picks from the highest-priority serving credential; ties go to listing order.
 */
export function gatewayAccounts(credentials: HubCredential[], providers: readonly ProviderId[]): GatewayAccount[] {
  const ccsProvider = (c: HubCredential) => (c.provider === "claude" ? "anthropic" : c.provider === "xai" ? "grok" : c.provider);
  const wanted = credentials.filter((c): c is HubCredential & { email: string } =>
    !!c.email && (providers as readonly string[]).includes(ccsProvider(c)));
  const first = new Map<string, HubCredential>();
  for (const c of wanted) {
    if (c.disabled || c.unavailable || c.status === "error") continue;
    const best = first.get(c.provider);
    if (!best || (c.priority ?? 0) > (best.priority ?? 0)) first.set(c.provider, c);
  }
  return wanted.map((c) => ({
    provider: ccsProvider(c),
    email: c.email,
    priority: c.priority ?? 0,
    disabled: c.disabled,
    firstInLine: first.get(c.provider) === c,
  }));
}

export async function collectSnapshot(opts: {
  providers?: readonly ProviderId[];
  hub?: () => Promise<HubRead>;
  now?: () => number;
}): Promise<UsageSnapshot> {
  const wanted = opts.providers ?? PROVIDERS;
  const hub = await (opts.hub ?? readHubSnapshot)();
  const nowMs = (opts.now ?? Date.now)();
  if (Bun.env.CCS_USAGE_DEBUG) {
    console.error(`ccs usage: ${hub.ok ? `hub snapshot collected ${new Date(hub.snapshot.collectedAt).toISOString()}${hub.unreachable ? ` from cache (${hub.unreachable})` : ""}` : hub.detail}`);
  }
  const results: AdapterResult[] = wanted.map((p) => hub.ok
    ? hubAdapter(p, hub.snapshot, nowMs, hub.unreachable)
    : { observations: [], health: { provider: p, status: "unavailable", detail: hub.detail } });
  return {
    generatedAt: new Date(nowMs).toISOString(),
    observations: results.flatMap((r) => r.observations),
    adapters: results.map((r) => r.health),
    subscriptions: mergeSubscriptionRenewals(
      resolveSubscriptions(wanted, new Date(nowMs)),
      results.flatMap((r) => r.renewals ?? []),
    ),
    ...(hub.ok ? { gateway: { base: hub.site, accounts: gatewayAccounts(hub.snapshot.credentials, wanted) } } : {}),
  };
}
