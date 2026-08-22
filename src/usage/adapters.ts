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
import { entryErrorHealth, runCodexBar, type RawCodexBarEntry } from "./codexbar.ts";

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
  entitlement: string,
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
              ...(res.value.version ? { helper: { name: "codexbar", version: res.value.version } } : {}),
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
  return collectCodexBarProvider("codex", "codex", "codex-pro", (entry) => {
    const usage = entry.usage as CodexUsage | undefined;
    if (!usage) return [];
    const observedAt = usage.updatedAt ?? now();
    const out: UsageObservation[] = windowObservations(
      "codex", "codex-pro", "account",
      [
        ["primary", usage.primary ?? null],
        ["secondary", usage.secondary ?? null],
        ["tertiary", usage.tertiary ?? null],
      ],
      observedAt,
      "official_cli",
    );
    // Spark windows ride in extraRateWindows but are still ordinary allowance windows.
    for (const extra of usage.extraRateWindows ?? []) {
      if (!extra.window) continue;
      out.push(...windowObservations("codex", "codex-spark", "account", [[extra.title ?? extra.id ?? "spark", extra.window]], observedAt, "official_cli"));
    }
    // Banked reset credits: lifecycle state, grant and expiry — never merged with windows.
    const rc = usage.codexResetCredits;
    if (rc?.credits) {
      for (const c of rc.credits) {
        out.push({
          provider: "codex",
          entitlement: "codex-reset-credit",
          metric: "reset_credit",
          scope: "account",
          window: null,
          used: null,
          limit: null,
          remaining: c.status === "available" ? 1 : 0,
          resetsAt: null,
          expiresAt: c.expires_at ?? null,
          observedAt: rc.updatedAt ?? observedAt,
          source: "official_cli",
          exact: true,
        });
      }
    }
    // Paid dollar credits stay separate from reset credits.
    if (typeof usage.credits?.remaining === "number") {
      out.push({
        provider: "codex",
        entitlement: "codex-dollar-credit",
        metric: "credit",
        scope: "account",
        window: null,
        used: null,
        limit: null,
        remaining: usage.credits.remaining,
        resetsAt: null,
        expiresAt: null,
        observedAt: usage.credits.updatedAt ?? observedAt,
        source: "official_cli",
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
  return collectCodexBarProvider("claude", "anthropic", "claude-max-personal", (entry) => {
    const usage = entry.usage as CodexUsage | undefined;
    if (!usage) return [];
    const observedAt = usage.updatedAt ?? now();
    return windowObservations(
      "anthropic", "claude-max-personal", "account",
      [
        ["primary", usage.primary ?? null],
        ["secondary", usage.secondary ?? null],
        ["tertiary", usage.tertiary ?? null],
      ],
      observedAt,
      "official_ui",
    );
  }, () => "no claude usage entries returned");
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

function grokAdapter(): AdapterResult {
  return collectCodexBarProvider("grok", "grok", "grok-consumer-oidc", (entry) => {
    const usage = entry.usage as CodexUsage | undefined;
    if (!usage) return [];
    const observedAt = usage.updatedAt ?? now();
    const out = windowObservations(
      "grok", "grok-consumer-oidc", "organization",
      [
        ["primary", usage.primary ?? null],
        ["secondary", usage.secondary ?? null],
        ["tertiary", usage.tertiary ?? null],
      ],
      observedAt,
      "official_ui",
    );
    return out;
  }, () => "no grok usage entries returned");
}

// ---------------------------------------------------------------------------
// OpenCode Go
// ---------------------------------------------------------------------------

function opencodeGoAdapter(): AdapterResult {
  return collectCodexBarProvider("opencodego", "opencode-go", "opencode-go-zen", (entry) => {
    const usage = entry.usage as CodexUsage | undefined;
    if (!usage) return [];
    const observedAt = usage.updatedAt ?? now();
    return windowObservations(
      "opencode-go", "opencode-go-zen", "account",
      [
        ["primary", usage.primary ?? null],
        ["secondary", usage.secondary ?? null],
        ["tertiary", usage.tertiary ?? null],
      ],
      observedAt,
      "official_cli",
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

async function veniceFetch(path: string): Promise<Response> {
  const key = await veniceApiKey();
  return fetch(`https://api.venice.ai/api/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
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
  const results: AdapterResult[] = [];
  for (const p of wanted) {
    switch (p) {
      case "codex": results.push(codexAdapter()); break;
      case "anthropic": results.push(anthropicAdapter()); break;
      case "grok": results.push(grokAdapter()); break;
      case "opencode-go": results.push(opencodeGoAdapter()); break;
      case "venice": results.push(await veniceAdapter()); break;
    }
  }
  return {
    generatedAt: now(),
    observations: results.flatMap((r) => r.observations),
    adapters: results.map((r) => r.health),
  };
}
