/**
 * Grok consumer subscription billing, read directly from xAI's own surfaces using the
 * OIDC token in ~/.grok/auth.json (written by `grok login`).
 *
 * Endpoints (verified live 2026-08-22):
 *  - GET https://cli-chat-proxy.grok.com/v1/billing?format=credits — weekly usage
 *    percent, product breakdown (GrokBuild/GrokChat/GrokImagine), prepaid balance,
 *    current period start/end. JSON.
 *  - GET https://grok.com/rest/subscriptions — active plan tier
 *    (e.g. SUBSCRIPTION_TIER_SUPER_GROK_PLUS). JSON.
 */

import { err, ok, type Result } from "../result.ts";
import type { AdapterHealth } from "./types.ts";

export interface GrokCreditsConfig {
  config?: {
    currentPeriod?: { type?: string; start?: string; end?: string };
    creditUsagePercent?: number;
    productUsage?: Array<{ product?: string; usagePercent?: number }>;
    isUnifiedBillingUser?: boolean;
    prepaidBalance?: { val?: number } | null;
    onDemandCap?: { val?: number } | null;
    onDemandUsed?: { val?: number } | null;
  };
}

export interface GrokSubscriptions {
  subscriptions?: Array<{ tier?: string; status?: string }>;
}

const GROK_TIMEOUT_MS = 15_000;

export interface GrokBilling {
  credits: GrokCreditsConfig;
  tier: string | null;
  email: string;
}

/** Read identity + token from ~/.grok/auth.json. Values never leave this module raw. */
function grokIdentity(): Result<{ key: string; userId: string; email: string }, AdapterHealth> {
  let auth: Record<string, { email?: string; key?: string; user_id?: string; expires_at?: string }>;
  try {
    auth = JSON.parse(new TextDecoder().decode(Bun.spawnSync(["cat", `${process.env.HOME}/.grok/auth.json`]).stdout));
  } catch {
    return err({ provider: "grok", status: "unavailable", detail: "~/.grok/auth.json unreadable — run `grok login`" });
  }
  const entry = Object.entries(auth)
    .filter(([k]) => k.startsWith("https://auth.x.ai::"))
    .map(([, v]) => v)
    .find((v) => v.key && (!v.expires_at || Date.parse(v.expires_at) > Date.now()));
  if (!entry?.key || !entry.user_id) {
    return err({ provider: "grok", status: "unavailable", detail: "no unexpired grok OIDC token — run `grok login`" });
  }
  return ok({ key: entry.key, userId: entry.user_id, email: entry.email ?? "unknown" });
}

async function getJson(url: string, key: string, userId: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      "x-userid": userId,
      Accept: "application/json",
      "x-grok-client-mode": "cli",
      "x-grok-client-version": "1.0.5",
    },
    signal: AbortSignal.timeout(GROK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url.split("grok.com")[1]} HTTP ${res.status}`);
  return res.json();
}

export async function fetchGrokBilling(): Promise<Result<GrokBilling, AdapterHealth>> {
  const id = grokIdentity();
  if (!id.ok) return err(id.error);
  const { key, userId, email } = id.value;
  try {
    const [credits, subs] = await Promise.all([
      getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", key, userId) as Promise<GrokCreditsConfig>,
      getJson("https://grok.com/rest/subscriptions", key, userId).catch(() => null) as Promise<GrokSubscriptions | null>,
    ]);
    const active = subs?.subscriptions?.find((s) => s.status === "SUBSCRIPTION_STATUS_ACTIVE")?.tier;
    return ok({
      credits,
      tier: active ? active.replace("SUBSCRIPTION_TIER_", "").replaceAll("_", " ").toLowerCase() : null,
      email,
    });
  } catch (e) {
    return err({
      provider: "grok",
      status: "unavailable",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}
