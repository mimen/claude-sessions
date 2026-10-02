/**
 * Live Codex usage from ChatGPT's wham endpoint, one gateway api-call per Codex credential.
 * The gateway owns the tokens and their refresh.
 */

import type { RawCodexBarEntry } from "./codexbar.ts";
import type { Gateway } from "./gateway.ts";

export const WHAM_URL = "https://chatgpt.com/backend-api/wham/usage";
export const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

interface WhamWindow {
  used_percent?: unknown;
  reset_at?: unknown;
  limit_window_seconds?: unknown;
}

interface WhamUsage {
  plan_type?: unknown;
  rate_limit?: {
    primary_window?: WhamWindow | null;
    secondary_window?: WhamWindow | null;
  };
  credits?: { balance?: unknown };
}

interface ResetCredit {
  id?: unknown;
  status?: unknown;
  granted_at?: unknown;
  expires_at?: unknown;
  redeemed_at?: unknown;
  title?: unknown;
}

interface ResetCreditsResponse {
  credits?: ResetCredit[];
  available_count?: unknown;
}

/** Same shape CodexBar emits under `usage.codexResetCredits`, which adapters.ts already reads. */
interface CodexResetCredits {
  availableCount: number;
  credits: ResetCredit[];
  updatedAt: string;
}

interface CodexUsageShape {
  updatedAt: string;
  identity: { accountEmail: string; loginMethod?: string };
  primary?: { usedPercent: number; resetsAt: string | null; windowMinutes: number | null };
  secondary?: { usedPercent: number; resetsAt: string | null; windowMinutes: number | null };
  codexResetCredits?: CodexResetCredits;
}

export interface LiveCodexAccounts {
  ok: RawCodexBarEntry[];
  emails: string[];
  failures: { email: string; detail: string }[];
}

function unixToIso(value: unknown): string | null {
  // Wham reset_at is unix seconds. adapters.toIsoTimestamp treats a number as CF AbsoluteTime.
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

function parseWindow(raw: WhamWindow | null | undefined): {
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
} | undefined {
  if (!raw || typeof raw.used_percent !== "number") return undefined;
  const seconds = raw.limit_window_seconds;
  return {
    usedPercent: raw.used_percent,
    resetsAt: unixToIso(raw.reset_at),
    windowMinutes: typeof seconds === "number" && Number.isFinite(seconds) ? seconds / 60 : null,
  };
}

export function parseWhamUsage(
  payload: unknown,
  identity: { email: string },
  observedAt: string,
): RawCodexBarEntry {
  const body = payload as WhamUsage;
  const usage: CodexUsageShape = {
    updatedAt: observedAt,
    identity: {
      accountEmail: identity.email,
      loginMethod: typeof body.plan_type === "string" ? body.plan_type : undefined,
    },
  };
  const primary = parseWindow(body.rate_limit?.primary_window ?? undefined);
  if (primary) usage.primary = primary;
  const secondary = parseWindow(body.rate_limit?.secondary_window ?? undefined);
  if (secondary) usage.secondary = secondary;

  const entry: RawCodexBarEntry = { provider: "codex", source: "oauth", usage };
  const balance = body.credits?.balance;
  if (typeof balance === "number" && Number.isFinite(balance)) {
    entry.credits = { remaining: balance, updatedAt: observedAt };
  }
  return entry;
}

export function parseResetCredits(payload: unknown, observedAt: string): CodexResetCredits {
  const body = payload as ResetCreditsResponse;
  const credits = Array.isArray(body.credits) ? body.credits : [];
  return {
    availableCount: typeof body.available_count === "number"
      ? body.available_count
      : credits.filter((c) => c.status === "available").length,
    credits: credits.map(({ id, status, granted_at, expires_at, redeemed_at, title }) =>
      ({ id, status, granted_at, expires_at, redeemed_at, title })),
    updatedAt: observedAt,
  };
}

export async function readLiveCodexAccounts(gateway: Gateway, opts?: { now?: () => string }): Promise<LiveCodexAccounts> {
  const observedAt = (opts?.now ?? (() => new Date().toISOString()))();
  const ok: RawCodexBarEntry[] = [];
  const emails: string[] = [];
  const failures: LiveCodexAccounts["failures"] = [];
  const seen = new Set<string>();

  for (const cred of gateway.credentials) {
    if (cred.provider !== "codex" || seen.has(cred.email.toLowerCase())) continue;
    seen.add(cred.email.toLowerCase());
    const header: Record<string, string> = { Authorization: "Bearer $TOKEN$", Accept: "application/json" };
    if (cred.chatgptAccountId) header["ChatGPT-Account-Id"] = cred.chatgptAccountId;
    try {
      const usage = await gateway.call(cred.authIndex, WHAM_URL, header);
      if (usage.status !== 200 || usage.body == null) {
        failures.push({ email: cred.email, detail: `HTTP ${usage.status}` });
        continue;
      }
      const entry = parseWhamUsage(usage.body, { email: cred.email }, observedAt);
      // wham/usage only carries a count; the expiry lives on this second endpoint.
      const resets = await gateway.call(cred.authIndex, RESET_CREDITS_URL, header);
      if (resets.status === 200 && resets.body != null) {
        (entry.usage as CodexUsageShape).codexResetCredits = parseResetCredits(resets.body, observedAt);
      }
      ok.push(entry);
      emails.push(cred.email);
    } catch (e) {
      failures.push({ email: cred.email, detail: e instanceof Error ? e.message : "fetch failed" });
    }
  }
  return { ok, emails, failures };
}
