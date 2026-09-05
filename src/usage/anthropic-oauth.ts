/**
 * Live Anthropic usage straight from the OAuth endpoint, per cswap-managed account.
 *
 * cswap's own usage cache goes stale whenever a stored token is revoked (its
 * usageStatus flips to no_credentials and it serves lastGoodUsage silently).
 * cswap keeps each account's real OAuth payload in the login keychain under
 * service "claude-swap", account "account-<n>-<email>"; we read the token there
 * and call api.anthropic.com/api/oauth/usage (oauth-2025-04-20 beta) — the same
 * endpoint claude.ai's settings page uses.
 */

import type { UsageWindow } from "./types.ts";

export interface KeychainOauth {
  accessToken: string;
  rateLimitTier: string | null;
}

interface OauthWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

/** One entry of the endpoint's `limits` array: the authoritative per-window reading. */
export interface OauthLimit {
  kind?: string | null;
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null; surface?: string | null } | null;
}

export interface OauthUsage {
  five_hour?: OauthWindow | null;
  seven_day?: OauthWindow | null;
  seven_day_opus?: OauthWindow | null;
  seven_day_sonnet?: OauthWindow | null;
  /** Codename for the scoped Fable weekly window. */
  nimbus_quill?: OauthWindow | null;
  limits?: OauthLimit[] | null;
}

export interface OauthProfile {
  account?: { has_claude_max?: boolean | null; has_claude_pro?: boolean | null } | null;
  organization?: { organization_type?: string | null; rate_limit_tier?: string | null } | null;
}

export interface OauthWindowReading {
  window: UsageWindow;
  /** "" for the account-wide window, "#Fable" for a model-scoped one. */
  suffix: string;
  utilization: number;
  resetsAt: string | null;
}

/**
 * The `limits` array is what claude.ai renders. The legacy top-level fields
 * (`nimbus_quill` for Fable) stopped tracking it and now read 0 while the scoped
 * limit sits at a real number, so they are only a fallback for older payloads.
 */
export function windowsFromOauthUsage(usage: OauthUsage): OauthWindowReading[] {
  const out: OauthWindowReading[] = [];
  for (const l of usage.limits ?? []) {
    if (typeof l.percent !== "number") continue;
    const resetsAt = l.resets_at ?? null;
    if (l.kind === "session") out.push({ window: "five_hour", suffix: "", utilization: l.percent, resetsAt });
    else if (l.kind === "weekly_all") out.push({ window: "weekly", suffix: "", utilization: l.percent, resetsAt });
    else if (l.kind === "weekly_scoped") {
      const name = l.scope?.model?.display_name ?? l.scope?.surface;
      if (name) out.push({ window: "weekly", suffix: `#${name}`, utilization: l.percent, resetsAt });
    }
  }
  if (out.length > 0) return out;

  const legacy = (w: OauthWindow | null | undefined, window: UsageWindow, suffix: string) => {
    if (w && typeof w.utilization === "number") {
      out.push({ window, suffix, utilization: w.utilization, resetsAt: w.resets_at ?? null });
    }
  };
  legacy(usage.five_hour, "five_hour", "");
  legacy(usage.seven_day, "weekly", "");
  for (const scoped of SCOPED_WINDOWS) legacy(usage[scoped.key], "weekly", scoped.suffix);
  return out;
}

/**
 * Plan from the profile endpoint, which the subscription actually governs. The
 * keychain's rateLimitTier is whatever Claude Code stamped at login and has been
 * seen carrying a Max tier on a Pro account.
 */
export function planFromProfile(
  profile: OauthProfile | null,
  keychainTier: string | null | undefined,
): { name: string; dollars: number } | null {
  const org = profile?.organization;
  const fromTier = planFromTier(org?.rate_limit_tier);
  if (fromTier) return fromTier;
  if (org?.organization_type === "claude_pro" || profile?.account?.has_claude_pro) return { name: "Pro", dollars: 20 };
  if (org?.organization_type === "claude_max" || profile?.account?.has_claude_max) return { name: "Max", dollars: 100 };
  return planFromTier(keychainTier);
}

export function readKeychainOauth(accountNumber: number, email: string): KeychainOauth | null {
  const proc = Bun.spawnSync({
    cmd: [
      "/usr/bin/security", "find-generic-password",
      "-s", "claude-swap",
      "-a", `account-${accountNumber}-${email}`,
      "-w",
    ],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      claudeAiOauth?: { accessToken?: string; rateLimitTier?: string };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    if (!token) return null;
    return { accessToken: token, rateLimitTier: parsed.claudeAiOauth?.rateLimitTier ?? null };
  } catch {
    return null;
  }
}

async function oauthGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`https://api.anthropic.com/api/oauth/${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`oauth ${path} HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  return (await res.json()) as T;
}

export function fetchOauthUsage(accessToken: string): Promise<OauthUsage> {
  return oauthGet<OauthUsage>("usage", accessToken);
}

/** Null on failure: the plan label is decoration, the windows are the data. */
export function fetchOauthProfile(accessToken: string): Promise<OauthProfile | null> {
  return oauthGet<OauthProfile>("profile", accessToken).catch(() => null);
}

/** Plan display info decoded from the keychain rateLimitTier. */
export function planFromTier(tier: string | null | undefined): { name: string; dollars: number } | null {
  const t = (tier ?? "").toLowerCase();
  if (t.includes("max_20")) return { name: "Max 20x", dollars: 200 };
  if (t.includes("max_5")) return { name: "Max 5x", dollars: 100 };
  if (t.includes("pro") || t === "default_claude_ai") return { name: "Pro", dollars: 20 };
  if (t.includes("max")) return { name: "Max", dollars: 100 };
  return null;
}

/** Scoped weekly windows by API codename, in render order. */
export const SCOPED_WINDOWS: readonly { key: "nimbus_quill" | "seven_day_opus" | "seven_day_sonnet"; suffix: string }[] = [
  { key: "nimbus_quill", suffix: "#Fable" },
  { key: "seven_day_opus", suffix: "#Opus" },
  { key: "seven_day_sonnet", suffix: "#Sonnet" },
];
