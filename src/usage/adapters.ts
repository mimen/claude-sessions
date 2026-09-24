/**
 * Provider adapters for `ccs usage`. Each adapter returns { observations, health } and
 * never throws: a provider that cannot answer degrades to AdapterHealth so one broken
 * adapter cannot collapse the command (plan commitment).
 *
 * Sources, per plan:
 *  - codex → ChatGPT wham usage per cliproxy OAuth file
 *  - anthropic → cswap's per-account Anthropic OAuth usage snapshots
 *  - grok → xAI billing/subscription JSON + reset-grant gRPC-Web surfaces
 */

import { readFileSync } from "node:fs";
import type {
  AdapterHealth,
  ProviderId,
  SubscriptionRenewal,
  UsageObservation,
  UsageSnapshot,
  UsageWindow,
} from "./types.ts";
import { sourceClassFor, type RawCodexBarEntry } from "./codexbar.ts";
import { readLiveCodexAccounts } from "./codex-oauth.ts";
import { runCswap, type CswapWindow } from "./cswap.ts";
import { bankedResetsFromOauthUsage, fetchOauthProfile, fetchOauthUsage, planFromProfile, readKeychainOauth, windowsFromOauthUsage } from "./anthropic-oauth.ts";
import { fetchGrokBilling } from "./grok.ts";
import { fetchGatewayClaudeCredentials, gatewayIssues, type GatewayIssue } from "./gateway-claude-health.ts";
import { mergeSubscriptionRenewals, renewalDate, resolveSubscriptions } from "./subscriptions.ts";

export interface AdapterResult {
  observations: UsageObservation[];
  health: AdapterHealth;
  renewals?: SubscriptionRenewal[];
}

const PROVIDERS: readonly ProviderId[] = ["codex", "anthropic", "grok"];

function now(): string {
  return new Date().toISOString();
}

interface CodexBarWindow {
  usedPercent?: number | null;
  resetsAt?: string | number | null;
  resetDescription?: string | null;
  windowMinutes?: number | null;
}

/** CoreFoundation AbsoluteTime (seconds since 2001-01-01 UTC) as used by CodexBar snapshots. */
const CF_ABSOLUTE_EPOCH = 978_307_200;

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date((value + CF_ABSOLUTE_EPOCH) * 1000).toISOString();
  }
  return null;
}

/** Map a window length to the plan's window vocabulary. */
function windowFor(minutes: number | null | undefined): UsageObservation["window"] {
  if (minutes == null) return null;
  if (minutes <= 5) return "minute";
  if (minutes <= 300) return "five_hour";
  if (minutes <= 1440) return "daily";
  if (minutes <= 10080) return "weekly";
  return "monthly";
}

// ---------------------------------------------------------------------------
// CodexBar-backed providers
// ---------------------------------------------------------------------------

interface Identity {
  accountEmail?: string;
  loginMethod?: string;
}

/** Label an account the way snapshots reference it — email when present, else login method. */
export function accountLabel(identity: Identity | undefined): string {
  return identity?.accountEmail ?? identity?.loginMethod ?? "unknown";
}

/**
 * Entitlement id per CodexBar ENTRY, not per adapter: Anthropic runs two separate
 * subscriptions (personal + AUF), and CodexBar returns one entry per account. The email
 * distinguishes them; without it every entry collapses into the base entitlement.
 */
export function accountEntitlement(base: string, identity: Identity | undefined, entry: RawCodexBarEntry): string {
  const email = identity?.accountEmail;
  if (!email || entry.error) return base;
  return `${base}:${email}`;
}

interface CodexSnapshotRecord {
  id?: string;
  sourceLabel?: string;
  credits?: { remaining?: number; updatedAt?: string | number };
  snapshot?: CodexUsage & { extraRateWindows?: CodexUsage["extraRateWindows"] };
}

function snapshotRecords(raw: unknown): CodexSnapshotRecord[] {
  if (Array.isArray(raw)) return raw as CodexSnapshotRecord[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { records?: unknown }).records)) {
    return (raw as { records: CodexSnapshotRecord[] }).records;
  }
  return [];
}

function loadCodexAccountSnapshots(): unknown {
  const home = Bun.env.HOME;
  if (!home) return null;
  try {
    return JSON.parse(readFileSync(
      `${home}/Library/Application Support/CodexBar/codex-account-snapshots.json`,
      "utf8",
    ));
  } catch {
    return null;
  }
}

function entryFromSnapshotRecord(record: CodexSnapshotRecord): RawCodexBarEntry | null {
  if (!record.snapshot) return null;
  return {
    provider: "codex",
    source: record.sourceLabel ?? "oauth",
    usage: record.snapshot,
    credits: record.credits
      ? {
          remaining: record.credits.remaining,
          updatedAt: toIsoTimestamp(record.credits.updatedAt) ?? undefined,
        }
      : undefined,
  };
}

/**
 * CodexBar `--all-accounts` only returns the live system OAuth account. Parked
 * ChatGPT logins still have meters in `codex-account-snapshots.json`.
 */
export function inactiveCodexSnapshotObservations(
  records: unknown,
  liveEmails: Iterable<string>,
): UsageObservation[] {
  const live = new Set([...liveEmails].map((email) => email.toLowerCase()));
  const out: UsageObservation[] = [];
  for (const record of snapshotRecords(records)) {
    const entry = entryFromSnapshotRecord(record);
    const email = (entry?.usage as CodexUsage | undefined)?.identity?.accountEmail
      ?? record.id;
    if (!entry || !email || live.has(email.toLowerCase())) continue;
    out.push(...codexObservationsFromEntry(entry, true));
  }
  return out;
}

function windowObservations(
  provider: ProviderId,
  entitlement: string,
  scope: UsageObservation["scope"],
  windows: Array<[string, CodexBarWindow | null]>,
  observedAt: string,
  sourceClass: UsageObservation["source"],
  stale = false,
): UsageObservation[] {
  const out: UsageObservation[] = [];
  for (const [name, w] of windows) {
    if (!w) continue;
    out.push({
      provider,
      entitlement,
      metric: "allowance",
      scope,
      window: windowFor(w.windowMinutes),
      used: typeof w.usedPercent === "number" ? w.usedPercent : null,
      limit: typeof w.usedPercent === "number" ? 100 : null,
      remaining:
        typeof w.usedPercent === "number" ? Math.max(0, 100 - w.usedPercent) : null,
      resetsAt: toIsoTimestamp(w.resetsAt),
      expiresAt: null,
      observedAt,
      source: sourceClass,
      // Percentages from the product surface are rounded by the provider itself.
      exact: false,
      ...(stale ? { stale: true } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

interface CodexUsage {
  updatedAt?: string | number;
  identity?: Identity;
  primary?: CodexBarWindow | null;
  secondary?: CodexBarWindow | null;
  tertiary?: CodexBarWindow | null;
  extraRateWindows?: Array<{ id?: string; title?: string; window?: CodexBarWindow }>;
  codexResetCredits?: {
    availableCount?: number;
    credits?: Array<{
      id?: string;
      status?: string;
      granted_at?: string | number;
      expires_at?: string | number;
      redeemed_at?: string | number;
      title?: string;
    }>;
    updatedAt?: string | number;
  };
  credits?: { remaining?: number; updatedAt?: string | number };
  subscriptionRenewsAt?: string | null;
}

function codexObservationsFromEntry(entry: RawCodexBarEntry, stale = false): UsageObservation[] {
  const usage = entry.usage as CodexUsage | undefined;
  if (!usage) return [];
  const observedAt = toIsoTimestamp(usage.updatedAt) ?? now();
  const srcClass = sourceClassFor(entry.source);
  const entitlement = accountEntitlement("codex-pro", usage.identity, entry);
  const out: UsageObservation[] = windowObservations(
    "codex", entitlement, "account",
    [
      ["primary", usage.primary ?? null],
      ["secondary", usage.secondary ?? null],
      ["tertiary", usage.tertiary ?? null],
    ],
    observedAt,
    srcClass,
    stale,
  );
  // Spark windows ride in extraRateWindows but consume a distinct Spark allowance —
  // they keep their own entitlement so the view never mislabels them as Codex Pro.
  for (const extra of usage.extraRateWindows ?? []) {
    if (!extra.window) continue;
    const id = extra.id ?? extra.title ?? "codex-spark";
    out.push(...windowObservations("codex", accountEntitlement(id, usage.identity, entry), "account", [[extra.title ?? id, extra.window]], observedAt, srcClass, stale));
  }
  // Banked reset credits carry full lifecycle state; "redeeming" is pending, not consumed.
  const rc = usage.codexResetCredits;
  if (rc?.credits) {
    for (const c of rc.credits) {
      out.push({
        provider: "codex",
        entitlement: accountEntitlement("codex-reset-credit", usage.identity, entry),
        metric: "reset_credit",
        scope: "account",
        window: null,
        used: null,
        limit: null,
        remaining: c.status === "available" ? 1 : null,
        resetsAt: null,
        expiresAt: toIsoTimestamp(c.expires_at),
        observedAt: toIsoTimestamp(rc.updatedAt) ?? observedAt,
        source: srcClass,
        exact: true,
        ...(stale ? { stale: true } : {}),
      });
    }
  }
  // Paid dollar credits are a TOP-LEVEL entry sibling of `usage` in CodexBar output.
  if (typeof entry.credits?.remaining === "number") {
    out.push({
      provider: "codex",
      entitlement: accountEntitlement("codex-dollar-credit", usage.identity, entry),
      metric: "credit",
      scope: "account",
      window: null,
      used: null,
      limit: null,
      remaining: entry.credits.remaining,
      resetsAt: null,
      expiresAt: null,
      observedAt: toIsoTimestamp(entry.credits.updatedAt) ?? observedAt,
      source: srcClass,
      exact: true,
      ...(stale ? { stale: true } : {}),
    });
  }
  return out;
}

function snapshotAccountEmails(observations: UsageObservation[]): string[] {
  const emails = new Set<string>();
  for (const observation of observations) {
    const email = observation.entitlement.split(":")[1];
    if (email) emails.add(email);
  }
  return [...emails];
}

async function codexAdapter(): Promise<AdapterResult> {
  const live = await readLiveCodexAccounts();
  const observations = live.ok.flatMap((entry) => codexObservationsFromEntry(entry));
  const snapshotObs = inactiveCodexSnapshotObservations(loadCodexAccountSnapshots(), live.emails);
  observations.push(...snapshotObs);
  const snapshotEmails = snapshotAccountEmails(snapshotObs);
  const named = [
    ...live.failures.map((failure) => `${failure.email} ${failure.detail}`),
    ...snapshotEmails.map((email) => `${email} on cached usage`),
  ];
  const health: AdapterHealth =
    observations.length === 0
      ? { provider: "codex", status: "unavailable", detail: named[0] ?? "no live Codex OAuth credentials" }
      : named.length === 0
        ? { provider: "codex", status: "ok", detail: null }
        : {
            provider: "codex",
            status: "degraded",
            detail: named.join("; "),
            accounts: [...live.failures.map((failure) => failure.email), ...snapshotEmails],
          };
  return { observations, health };
}

// ---------------------------------------------------------------------------
// Anthropic (CodexBar's Claude reader)
// ---------------------------------------------------------------------------

export function windowFromCswap(
  w: CswapWindow | null | undefined,
  observedAt: string,
  stale: boolean,
): UsageObservation | null {
  if (!w || typeof w.pct !== "number") return null;
  return {
    provider: "anthropic",
    entitlement: "", // set by caller
    metric: "allowance",
    scope: "account",
    window: null,
    used: w.pct,
    limit: 100,
    remaining: Math.max(0, 100 - w.pct),
    resetsAt: w.resetsAt ?? null,
    expiresAt: null,
    observedAt,
    source: "official_api",
    exact: false,
    // stale marks lastGoodUsage fallbacks (cswap could not refresh this account). Without it
    // a cached row renders as a live one, which is how a dead account showed a confident
    // percentage next to a healthy one.
    stale,
  } as UsageObservation & { stale?: boolean };
}

function anthropicAdapter(): AdapterResult {
  throw new Error("sync anthropicAdapter removed; use anthropicAdapterLive");
}

async function anthropicAdapterLive(): Promise<AdapterResult> {
  const res = runCswap();
  if (!res.ok) return { observations: [], health: res.error };
  const observations: UsageObservation[] = [];
  let okCount = 0;
  const staleAccounts: { email: string; status: string }[] = [];
  for (const acct of res.value.report.accounts ?? []) {
    if (!acct.email) continue;
    const base = `claude-max:${acct.email}`;
    const observedAt = now();

    // Preferred path: live OAuth fetch using the account's keychain token.
    // Falls back to cswap's (often stale) usage cache on any failure.
    const oauth = acct.number != null ? readKeychainOauth(acct.number, acct.email) : null;
    if (oauth) {
      try {
        const [usage, profile] = await Promise.all([
          fetchOauthUsage(oauth.accessToken),
          fetchOauthProfile(oauth.accessToken),
        ]);
        const tier = planFromProfile(profile, oauth.rateLimitTier);
        for (const w of windowsFromOauthUsage(usage)) {
          observations.push({
            provider: "anthropic",
            entitlement: `${base}${w.suffix}`,
            metric: "allowance",
            scope: "account",
            window: w.window,
            used: w.utilization,
            limit: 100,
            remaining: Math.max(0, 100 - w.utilization),
            resetsAt: w.resetsAt,
            expiresAt: null,
            observedAt,
            source: "official_api",
            exact: true,
            tier: tier?.name ?? null,
          } as UsageObservation & { tier?: string | null });
          okCount++;
        }
        for (const r of bankedResetsFromOauthUsage(usage)) {
          for (let i = 0; i < r.left; i++) {
            observations.push({
              provider: "anthropic",
              entitlement: `claude-reset-credit:${acct.email}`,
              metric: "reset_credit",
              scope: "account",
              window: null,
              used: null,
              limit: null,
              remaining: 1,
              resetsAt: null,
              expiresAt: r.expiresAt,
              observedAt,
              source: "official_api",
              exact: true,
            });
          }
        }
        continue;
      } catch {
        // token revoked/expired or endpoint down — fall through to cswap cache
      }
    }

    const live = acct.usageStatus === "ok";
    if (!live) staleAccounts.push({ email: acct.email, status: acct.usageStatus ?? "unknown" });
    const usage = (live ? acct.usage : acct.lastGoodUsage) ?? {};
    // A fallback row is as old as cswap's last live answer, not as old as this process. Dating
    // it `now()` told the menu bar every cached number was fresh.
    const rowObservedAt = live ? observedAt : (acct.lastGoodFetchedAt ?? observedAt);
    for (const [w, win] of [
      ["five_hour", usage.fiveHour],
      ["weekly", usage.sevenDay],
    ] as const) {
      const o = windowFromCswap(win, rowObservedAt, !live);
      if (!o) continue;
      o.entitlement = base;
      o.window = w;
      observations.push(o);
      okCount++;
    }
    // Anthropic may add model-family limits alongside the account windows. cswap
    // currently exposes Fable here; keep each named scope as its own full quota row.
    for (const scoped of usage.scoped ?? []) {
      if (!scoped.name) continue;
      const o = windowFromCswap(scoped, rowObservedAt, !live);
      if (!o) continue;
      o.entitlement = `${base}#${scoped.name}`;
      o.window = "weekly";
      observations.push(o);
      okCount++;
    }
  }
  // The gateway holds its own login per account; a dead one is invisible to cswap.
  const gateway = gatewayIssues(await fetchGatewayClaudeCredentials());
  return { observations, health: anthropicHealth(okCount, staleAccounts, gateway) };
}

/**
 * Name the accounts. Counting them ("1 account(s) on cached usage") forced the reader to go
 * find out which, which defeats the point of surfacing it at all. Both logins per account are
 * reported: cswap's slot status and the gateway credential's, each with its own re-auth path.
 */
export function anthropicHealth(
  okCount: number,
  staleAccounts: { email: string; status: string }[],
  gateway: GatewayIssue[],
): AdapterHealth {
  if (okCount === 0) {
    return { provider: "anthropic", status: "unavailable", detail: "no usable anthropic windows" };
  }
  const parts: string[] = [];
  if (staleAccounts.length > 0) {
    parts.push(`${staleAccounts.map((a) => `${a.email} (${a.status})`).join(", ")} on cached usage — re-auth via cswap`);
  }
  for (const issue of gateway) parts.push(`${issue.email} ${issue.reason}`);
  if (parts.length === 0) return { provider: "anthropic", status: "ok", detail: null };
  const accounts = [...new Set([...staleAccounts.map((a) => a.email), ...gateway.map((g) => g.email)])];
  return { provider: "anthropic", status: "degraded", detail: parts.join("; "), accounts };
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

async function grokAdapter(): Promise<AdapterResult> {
  const res = await fetchGrokBilling();
  if (!res.ok) return { observations: [], health: res.error };
  const { credits, resets, resetError, tier, email, renewsAt } = res.value;
  const c = credits.config;
  const observedAt = now();
  const entitlement =
    accountEntitlement(tier ? `grok-${tier}` : "grok-consumer-oidc", { accountEmail: email }, { provider: "grok" });
  const out: UsageObservation[] = [];

  // The shared weekly pool — one allowance across Build, Chat, and Imagine.
  if (typeof c?.creditUsagePercent === "number") {
    out.push({
      provider: "grok",
      entitlement,
      metric: "allowance",
      scope: "organization",
      window: "weekly",
      used: c.creditUsagePercent,
      limit: 100,
      remaining: Math.max(0, 100 - c.creditUsagePercent),
      resetsAt: c.currentPeriod?.end ?? null,
      expiresAt: null,
      observedAt,
      source: "official_api",
      exact: true,
    });
    // Product breakdown rows under the same pool.
    for (const p of c.productUsage ?? []) {
      if (!p.product) continue;
      // proto3 omits zero-valued usagePercent, but the product is still an explicit 0% row.
      const productPercent = p.usagePercent ?? 0;
      out.push({
        provider: "grok",
        // "#" suffix = product sub-row of the same pool; renderer names it, grouping ignores it.
        entitlement: `${entitlement}#${p.product.replace("Grok", "").toLowerCase()}`,
        metric: "allowance",
        scope: "organization",
        window: "weekly",
        used: productPercent,
        limit: 100,
        remaining: Math.max(0, 100 - productPercent),
        resetsAt: c.currentPeriod?.end ?? null,
        expiresAt: null,
        observedAt,
        source: "official_api",
        exact: true,
      });
    }
  }
  // Redeemable full-reset grants — distinct from the automatic weekly reset.
  for (const grant of resets) {
    out.push({
      provider: "grok",
      entitlement: `${entitlement}#reset`,
      metric: "reset_credit",
      scope: "organization",
      window: null,
      used: null,
      limit: null,
      remaining: 1,
      resetsAt: null,
      expiresAt: grant.expiresAt,
      observedAt,
      source: "official_api",
      exact: true,
    });
  }
  // Prepaid Extra Usage Credits in cents. Emit zero too: explicit "none" is useful detail.
  const prepaid = c?.prepaidBalance?.val;
  if (typeof prepaid === "number") {
    out.push({
      provider: "grok",
      entitlement: `${entitlement}#prepaid`,
      metric: "credit",
      scope: "organization",
      window: null,
      used: null,
      limit: null,
      remaining: prepaid / 100,
      resetsAt: null,
      expiresAt: null,
      observedAt,
      source: "official_api",
      exact: true,
    });
  }
  const renewsOn = renewalDate(renewsAt);
  return {
    observations: out,
    renewals: renewsOn ? [{
      provider: "grok",
      account: email,
      renewsOn,
      source: "official_api",
    }] : [],
    health: out.length === 0
      ? { provider: "grok", status: "unavailable", detail: "billing returned no usable fields" }
      : resetError
        ? { provider: "grok", status: "degraded", detail: `usage available; reset grants unavailable: ${resetError}` }
        : { provider: "grok", status: "ok", detail: null },
  };
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

export async function collectSnapshot(opts: { providers?: readonly ProviderId[] }): Promise<UsageSnapshot> {
  const wanted = opts.providers ?? PROVIDERS;
  // Final containment boundary: an adapter that throws despite its own error handling
  // degrades to AdapterHealth here — one broken adapter never collapses the command.
  const results: AdapterResult[] = [];
  for (const p of wanted) {
    try {
      results.push(
        p === "codex" ? await codexAdapter()
        : p === "grok" ? await grokAdapter()
        : await anthropicAdapterLive(),
      );
    } catch (e) {
      results.push({
        observations: [],
        health: { provider: p, status: "unavailable", detail: e instanceof Error ? e.message : String(e) },
      });
    }
  }
  return {
    generatedAt: now(),
    observations: results.flatMap((r) => r.observations),
    adapters: results.map((r) => r.health),
    subscriptions: mergeSubscriptionRenewals(
      resolveSubscriptions(wanted),
      results.flatMap((result) => result.renewals ?? []),
    ),
  };
}
