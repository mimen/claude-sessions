/**
 * Provider adapters for `ccs usage`. Each adapter returns { observations, health } and
 * never throws: a provider that cannot answer degrades to AdapterHealth so one broken
 * adapter cannot collapse the command (plan commitment).
 *
 * Sources, per plan:
 *  - codex / grok / opencode-go → CodexBar CLI JSON (official_cli class)
 *  - anthropic → CodexBar's Claude reader when it works; explicit degradation otherwise
 *    (consumer allowance has no supported public API; unknown beats fake precision)
 *  - venice → official billing balance + api_keys/rate_limits APIs (official_api class)
 */

import type {
  AdapterHealth,
  ProviderId,
  UsageObservation,
  UsageSnapshot,
} from "./types.ts";
import { codexBarVersion, entryErrorHealth, runCodexBar, sourceClassFor, type RawCodexBarEntry } from "./codexbar.ts";

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

function anthropicAdapter(): AdapterResult {
  return collectCodexBarProvider("claude", "anthropic", (entry) => {
    const usage = entry.usage as CodexUsage | undefined;
    if (!usage) return [];
    const observedAt = usage.updatedAt ?? now();
    // One entitlement PER ENTRY: personal and AUF subscriptions must stay separate, and
    // the email in each entry's identity is what distinguishes them.
    return windowObservations(
      "anthropic", accountEntitlement("claude-max", usage.identity, entry), "account",
      [
        ["primary", usage.primary ?? null],
        ["secondary", usage.secondary ?? null],
        ["tertiary", usage.tertiary ?? null],
      ],
      observedAt,
      sourceClassFor(entry.source),
    );
  }, () => "no claude usage entries returned");
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

function grokAdapter(): AdapterResult {
  return collectCodexBarProvider("grok", "grok", (entry) => {
    const usage = entry.usage as CodexUsage | undefined;
    if (!usage) return [];
    const observedAt = usage.updatedAt ?? now();
    return windowObservations(
      "grok", accountEntitlement("grok-consumer-oidc", usage.identity, entry), "organization",
      [
        ["primary", usage.primary ?? null],
        ["secondary", usage.secondary ?? null],
        ["tertiary", usage.tertiary ?? null],
      ],
      observedAt,
      sourceClassFor(entry.source),
    );
  }, () => "no grok usage entries returned");
}

// ---------------------------------------------------------------------------
// OpenCode Go
// ---------------------------------------------------------------------------

function opencodeGoAdapter(): AdapterResult {
  return collectCodexBarProvider("opencodego", "opencode-go", (entry) => {
    const usage = entry.usage as CodexUsage | undefined;
    if (!usage) return [];
    const observedAt = usage.updatedAt ?? now();
    return windowObservations(
      "opencode-go", accountEntitlement("opencode-go-zen", usage.identity, entry), "account",
      [
        ["primary", usage.primary ?? null],
        ["secondary", usage.secondary ?? null],
        ["tertiary", usage.tertiary ?? null],
      ],
      observedAt,
      sourceClassFor(entry.source),
    );
  }, () => "no opencodego usage entries returned");
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
        case "grok": return grokAdapter();
        case "opencode-go": return opencodeGoAdapter();
        case "venice": return { observations: [], health: { provider: p, status: "unavailable", detail: "venice adapter is async" } };
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
    if (p === "venice") {
      try {
        results.push(await veniceAdapter());
      } catch (e) {
        results.push({
          observations: [],
          health: { provider: "venice", status: "unavailable", detail: e instanceof Error ? e.message : String(e) },
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
