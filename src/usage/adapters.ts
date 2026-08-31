/**
 * Provider adapters for `ccs usage`. Each adapter returns { observations, health } and
 * never throws: a provider that cannot answer degrades to AdapterHealth so one broken
 * adapter cannot collapse the command (plan commitment).
 *
 * Sources, per plan:
 *  - codex → CodexBar CLI JSON
 *  - anthropic → cswap's per-account Anthropic OAuth usage snapshots
 *  - grok → xAI billing/subscription JSON + reset-grant gRPC-Web surfaces
 *  - opencode-go → official Go usage API
 *  - venice → official billing balance + api_keys/rate_limits APIs
 */

import type {
  AdapterHealth,
  ProviderId,
  UsageObservation,
  UsageSnapshot,
} from "./types.ts";
import { codexBarVersion, entryErrorHealth, runCodexBar, sourceClassFor, type RawCodexBarEntry } from "./codexbar.ts";
import { runCswap, type CswapWindow } from "./cswap.ts";
import { ageShort } from "./render.ts";
import { fetchGrokBilling } from "./grok.ts";

export interface AdapterResult {
  observations: UsageObservation[];
  health: AdapterHealth;
}

const PROVIDERS: readonly ProviderId[] = ["codex", "anthropic", "grok", "opencode-go", "venice"];

function now(): string {
  return new Date().toISOString();
}

interface CodexBarWindow {
  usedPercent?: number | null;
  resetsAt?: string | null;
  resetDescription?: string | null;
  windowMinutes?: number | null;
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

function windowObservations(
  provider: ProviderId,
  entitlement: string,
  scope: UsageObservation["scope"],
  windows: Array<[string, CodexBarWindow | null]>,
  observedAt: string,
  sourceClass: UsageObservation["source"],
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
      resetsAt: w.resetsAt ?? null,
      expiresAt: null,
      observedAt,
      source: sourceClass,
      // Percentages from the product surface are rounded by the provider itself.
      exact: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function collectCodexBarProvider(
  providerArg: string,
  providerId: ProviderId,
  perEntry: (entry: RawCodexBarEntry) => UsageObservation[],
  failureDetail: (entries: RawCodexBarEntry[]) => string,
): AdapterResult {
  const res = runCodexBar(providerArg);
  if (!res.ok) return { observations: [], health: { ...res.error, provider: providerId } };
  const observations: UsageObservation[] = [];
  let hadError = false;
  let lastError = "";
  for (const entry of res.value.entries) {
    if (entry.error) {
      hadError = true;
      lastError = entry.error.message ?? "unknown provider error";
      continue;
    }
    observations.push(...perEntry(entry));
  }
  const version = codexBarVersion();
  const health: AdapterHealth =
    hadError && observations.length === 0
      ? entryErrorHealth(providerId, lastError)
      : hadError
        ? { provider: providerId, status: "degraded", detail: `partial: ${lastError}` }
        : observations.length === 0
          ? entryErrorHealth(providerId, failureDetail(res.value.entries))
          : {
              provider: providerId,
              status: "ok",
              detail: null,
              ...(version ? { helper: { name: "codexbar", version } } : {}),
            };
  return { observations, health };
}

interface CodexUsage {
  updatedAt?: string;
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
      granted_at?: string;
      expires_at?: string;
      redeemed_at?: string;
      title?: string;
    }>;
    updatedAt?: string;
  };
  credits?: { remaining?: number; updatedAt?: string };
}

function codexAdapter(): AdapterResult {
  return collectCodexBarProvider("codex", "codex", (entry) => {
    const usage = entry.usage as CodexUsage | undefined;
    if (!usage) return [];
    const observedAt = usage.updatedAt ?? now();
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
    );
    // Spark windows ride in extraRateWindows but consume a distinct Spark allowance —
    // they keep their own entitlement so the view never mislabels them as Codex Pro.
    for (const extra of usage.extraRateWindows ?? []) {
      if (!extra.window) continue;
      const id = extra.id ?? extra.title ?? "codex-spark";
      out.push(...windowObservations("codex", id, "account", [[extra.title ?? id, extra.window]], observedAt, srcClass));
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
          expiresAt: c.expires_at ?? null,
          observedAt: rc.updatedAt ?? observedAt,
          source: srcClass,
          exact: true,
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
        observedAt: entry.credits.updatedAt ?? observedAt,
        source: srcClass,
        exact: true,
      });
    }
    return out;
  }, () => "no codex usage entries returned");
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
    // stale marks lastGoodUsage fallbacks (cswap could not refresh this account).
    ...(stale ? { stale: true } : {}),
  };
}

function anthropicAdapter(): AdapterResult {
  const res = runCswap();
  if (!res.ok) return { observations: [], health: res.error };
  const observations: UsageObservation[] = [];
  const staleAccounts: string[] = [];
  let okCount = 0;
  for (const acct of res.value.report.accounts ?? []) {
    if (!acct.email) continue;
    const base = `claude-max:${acct.email}`;
    const live = acct.usageStatus === "ok";
    const usage = (live ? acct.usage : acct.lastGoodUsage) ?? {};
    // Fallback observations keep the time they were actually fetched — a fresh
    // timestamp on days-old numbers is exactly the lie this view exists to avoid.
    const observedAt = live ? now() : (acct.lastGoodFetchedAt ?? now());
    if (!live) {
      const age = acct.lastGoodFetchedAt ? ` — showing data from ${ageShort(acct.lastGoodFetchedAt)} ago` : "";
      staleAccounts.push(`${acct.email} needs re-login (cswap add)${age}`);
    }
    for (const [w, win] of [
      ["five_hour", usage.fiveHour],
      ["weekly", usage.sevenDay],
    ] as const) {
      const o = windowFromCswap(win, observedAt, !live);
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
      const o = windowFromCswap(scoped, observedAt, !live);
      if (!o) continue;
      o.entitlement = `${base}#${scoped.name}`;
      o.window = "weekly";
      observations.push(o);
      okCount++;
    }
  }
  const health: AdapterHealth =
    okCount === 0
      ? { provider: "anthropic", status: "unavailable", detail: "cswap returned no usable windows" }
      : staleAccounts.length
        ? { provider: "anthropic", status: "degraded", detail: staleAccounts.join("; ") }
        : { provider: "anthropic", status: "ok", detail: null };
  return { observations, health };
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

async function grokAdapter(): Promise<AdapterResult> {
  const res = await fetchGrokBilling();
  if (!res.ok) return { observations: [], health: res.error };
  const { credits, resets, resetError, tier, email } = res.value;
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
  return {
    observations: out,
    health: out.length === 0
      ? { provider: "grok", status: "unavailable", detail: "billing returned no usable fields" }
      : resetError
        ? { provider: "grok", status: "degraded", detail: `usage available; reset grants unavailable: ${resetError}` }
        : { provider: "grok", status: "ok", detail: null },
  };
}

// ---------------------------------------------------------------------------
// OpenCode Go
// ---------------------------------------------------------------------------

interface GoUsageResponse {
  usage?: {
    rolling?: { status?: string; percent?: number; resetsAt?: string };
    weekly?: { status?: string; percent?: number; resetsAt?: string };
    monthly?: { status?: string; percent?: number; resetsAt?: string };
  };
}

let cachedGoKey: string | null = null;

/** Read the OpenCode Go API key from 1Password. Never logged or embedded. */
async function opencodeGoKey(): Promise<string> {
  if (cachedGoKey) return cachedGoKey;
  const proc = Bun.spawnSync(["op", "read", "op://Sol/OpenCode Go/credential"], {
    stdout: "pipe", stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error("could not read OpenCode Go credential from 1Password");
  cachedGoKey = new TextDecoder().decode(proc.stdout).trim();
  return cachedGoKey;
}

const GO_TIMEOUT_MS = 15_000;

/**
 * Official Go usage endpoint (GET /zen/go/v1/usage, Bearer key): rolling 5h, weekly,
 * and monthly value-window percentages with exact reset timestamps. Replaces the
 * CodexBar reader, which needed browser cookies this machine does not have.
 */
async function opencodeGoAdapter(): Promise<AdapterResult> {
  const observedAt = now();
  let data: GoUsageResponse;
  try {
    const key = await opencodeGoKey();
    const res = await fetch("https://opencode.ai/zen/go/v1/usage", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(GO_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        observations: [],
        health: { provider: "opencode-go", status: "unavailable", detail: `go/v1/usage HTTP ${res.status}` },
      };
    }
    data = (await res.json()) as GoUsageResponse;
  } catch (e) {
    return {
      observations: [],
      health: { provider: "opencode-go", status: "unavailable", detail: e instanceof Error ? e.message : String(e) },
    };
  }
  const u = data.usage ?? {};
  const windows: Array<[UsageObservation["window"], typeof u.rolling]> = [
    ["five_hour", u.rolling],
    ["weekly", u.weekly],
    ["monthly", u.monthly],
  ];
  const observations: UsageObservation[] = [];
  for (const [window, w] of windows) {
    if (!w || typeof w.percent !== "number") continue;
    observations.push({
      provider: "opencode-go",
      entitlement: "opencode-go-zen",
      metric: "allowance",
      scope: "account",
      window,
      used: w.percent,
      limit: 100,
      remaining: Math.max(0, 100 - w.percent),
      resetsAt: w.resetsAt ?? null,
      expiresAt: null,
      observedAt,
      source: "official_api",
      exact: true,
    });
  }
  return {
    observations,
    health: observations.length === 0
      ? { provider: "opencode-go", status: "degraded", detail: "endpoint returned no window data" }
      : { provider: "opencode-go", status: "ok", detail: null },
  };
}

// ---------------------------------------------------------------------------
// Venice — official APIs, no helper
// ---------------------------------------------------------------------------

interface VeniceRateLimits {
  data?: {
    accessPermitted?: boolean;
    apiTier?: { id?: string; isCharged?: boolean };
    balances?: { USD?: number; DIEM?: number };
    keyExpiration?: string | null;
    nextEpochBegins?: string | null;
    rateLimits?: Array<{ apiModelId?: string; rateLimits?: Array<{ amount?: number; type?: string }> }>;
  };
}

const VENICE_TIMEOUT_MS = 15_000;

async function veniceFetch(path: string): Promise<Response> {
  const key = await veniceApiKey();
  return fetch(`https://api.venice.ai/api/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(VENICE_TIMEOUT_MS),
  });
}

let cachedVeniceKey: string | null = null;

/** Read the Venice API key from 1Password via the service account. Never logged or embedded. */
async function veniceApiKey(): Promise<string> {
  if (cachedVeniceKey) return cachedVeniceKey;
  const proc = Bun.spawnSync(
    ["op", "read", "op://Sol/Venice AI/credential"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error("could not read Venice credential from 1Password");
  }
  cachedVeniceKey = new TextDecoder().decode(proc.stdout).trim();
  return cachedVeniceKey;
}

async function veniceAdapter(): Promise<AdapterResult> {
  const observedAt = now();
  let limits: VeniceRateLimits;
  try {
    const res = await veniceFetch("api_keys/rate_limits");
    if (!res.ok) {
      return {
        observations: [],
        health: { provider: "venice", status: "unavailable", detail: `rate_limits HTTP ${res.status}` },
      };
    }
    limits = (await res.json()) as VeniceRateLimits;
  } catch (e) {
    return {
      observations: [],
      health: {
        provider: "venice",
        status: "unavailable",
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }
  const d = limits.data ?? {};
  const observations: UsageObservation[] = [];

  // Balances are credit metrics — USD and DIEM stay separate fields, never summed.
  if (typeof d.balances?.USD === "number") {
    observations.push({
      provider: "venice",
      entitlement: "venice-usd-balance",
      metric: "credit",
      scope: "account",
      window: null,
      used: null,
      limit: null,
      remaining: d.balances.USD,
      resetsAt: null,
      expiresAt: d.keyExpiration ?? null,
      observedAt,
      source: "official_api",
      exact: true,
    });
  }
  if (typeof d.balances?.DIEM === "number") {
    observations.push({
      provider: "venice",
      entitlement: "venice-diem-balance",
      metric: "credit",
      scope: "account",
      window: null,
      used: null,
      limit: null,
      remaining: d.balances.DIEM,
      resetsAt: d.nextEpochBegins ?? null,
      expiresAt: null,
      observedAt,
      source: "official_api",
      exact: true,
    });
  }
  // Per-model rate limits are capacity, not consumption.
  for (const m of d.rateLimits ?? []) {
    if (!m.apiModelId) continue;
    const rpm = m.rateLimits?.find((r) => r.type === "RPM")?.amount;
    if (typeof rpm !== "number") continue;
    observations.push({
      provider: "venice",
      entitlement: `venice-model:${m.apiModelId}`,
      metric: "rate_limit",
      scope: "model",
      window: "minute",
      used: null,
      limit: rpm,
      remaining: null,
      resetsAt: null,
      expiresAt: null,
      observedAt,
      source: "official_api",
      exact: true,
    });
  }

  const tier = d.apiTier?.id ? `tier ${d.apiTier.id}` : "";
  return {
    observations,
    health: {
      provider: "venice",
      status: d.accessPermitted === false ? "degraded" : "ok",
      detail: d.accessPermitted === false ? `access not permitted${tier ? ` (${tier})` : ""}` : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

export async function collectSnapshot(opts: { providers?: readonly ProviderId[] }): Promise<UsageSnapshot> {
  const wanted = opts.providers ?? PROVIDERS;
  // Final containment boundary: an adapter that throws despite its own error handling
  // degrades to AdapterHealth here — one broken adapter never collapses the command.
  const run = (p: ProviderId): AdapterResult => {
    try {
      switch (p) {
        case "codex": return codexAdapter();
        case "anthropic": return anthropicAdapter();
        case "opencode-go":
        case "grok":
        case "venice":
          return { observations: [], health: { provider: p, status: "unavailable", detail: "async adapter" } };
      }
    } catch (e) {
      return {
        observations: [],
        health: { provider: p, status: "unavailable", detail: e instanceof Error ? e.message : String(e) },
      };
    }
  };
  const results: AdapterResult[] = [];
  for (const p of wanted) {
    if (p === "venice" || p === "opencode-go" || p === "grok") {
      // The two direct-API adapters are async; contain their throws like the sync ones.
      try {
        results.push(
          p === "venice" ? await veniceAdapter()
          : p === "grok" ? await grokAdapter()
          : await opencodeGoAdapter(),
        );
      } catch (e) {
        results.push({
          observations: [],
          health: { provider: p, status: "unavailable", detail: e instanceof Error ? e.message : String(e) },
        });
      }
    } else {
      results.push(run(p));
    }
  }
  return {
    generatedAt: now(),
    observations: results.flatMap((r) => r.observations),
    adapters: results.map((r) => r.health),
  };
}
