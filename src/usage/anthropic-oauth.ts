/**
 * Live Anthropic usage from the OAuth endpoint claude.ai's settings page uses
 * (api.anthropic.com/api/oauth/usage, oauth-2025-04-20 beta), per gateway Claude credential.
 */

import { readlinkSync } from "node:fs";
import { basename } from "node:path";
import { UpstreamError } from "./account-cache.ts";
import type { Gateway } from "./gateway.ts";
import type { UsageWindow } from "./types.ts";

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
  /** Codename for banked usage-limit resets; only present when asked for with `?cedar_ember=1`. */
  cedar_ember?: { eligible?: boolean | null; ineligible_reason?: string | null; grants?: OauthResetGrant[] | null } | null;
}

interface OauthResetGrant {
  label?: string | null;
  resets_left?: number | null;
  ends_at?: string | null;
}

export interface BankedReset {
  label: string;
  left: number;
  expiresAt: string | null;
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

/** Plan from the profile endpoint, which the subscription actually governs. */
export function planFromProfile(profile: OauthProfile | null): { name: string; dollars: number } | null {
  const org = profile?.organization;
  const fromTier = planFromTier(org?.rate_limit_tier);
  if (fromTier) return fromTier;
  if (org?.organization_type === "claude_pro" || profile?.account?.has_claude_pro) return { name: "Pro", dollars: 20 };
  if (org?.organization_type === "claude_max" || profile?.account?.has_claude_max) return { name: "Max", dollars: 100 };
  return null;
}

/**
 * The server reports banked resets (`cedar_ember`) only to a current Claude Code
 * client: any other agent gets `ineligible_reason: "surface"`, an old version gets
 * "cli_version". The installed version is the name of the file the launcher links to.
 */
function claudeCliUserAgent(): string | undefined {
  try {
    return `claude-cli/${basename(readlinkSync(`${Bun.env.HOME}/.local/bin/claude`))} (external, cli)`;
  } catch {
    return undefined;
  }
}

async function oauthGet<T>(gateway: Gateway, authIndex: string, path: string): Promise<T> {
  const userAgent = claudeCliUserAgent();
  const res = await gateway.call(authIndex, `https://api.anthropic.com/api/oauth/${path}`, {
    Authorization: "Bearer $TOKEN$",
    "anthropic-beta": "oauth-2025-04-20",
    ...(userAgent ? { "User-Agent": userAgent } : {}),
  });
  if (res.status !== 200 || res.body == null) throw new UpstreamError(`oauth ${path} HTTP ${res.status}`, res.retryAfter ?? null);
  return res.body as T;
}

export function fetchOauthUsage(gateway: Gateway, authIndex: string): Promise<OauthUsage> {
  return oauthGet<OauthUsage>(gateway, authIndex, "usage?cedar_ember=1");
}

/** Null on failure: the plan label is decoration, the windows are the data. */
export function fetchOauthProfile(gateway: Gateway, authIndex: string): Promise<OauthProfile | null> {
  return oauthGet<OauthProfile>(gateway, authIndex, "profile").catch(() => null);
}

export function bankedResetsFromOauthUsage(usage: OauthUsage): BankedReset[] {
  return (usage.cedar_ember?.grants ?? [])
    .filter((g) => (g.resets_left ?? 0) > 0)
    .map((g) => ({ label: g.label ?? "usage-limit reset", left: g.resets_left!, expiresAt: g.ends_at ?? null }));
}

/** Plan display info decoded from a rate_limit_tier string. */
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
