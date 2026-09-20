/**
 * Live Codex usage from ChatGPT's wham endpoint, one request per cliproxy OAuth file.
 * Tokens stay in this module. 401 re-reads the same file once; we never refresh.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawCodexBarEntry } from "./codexbar.ts";

const WHAM_URL = "https://chatgpt.com/backend-api/wham/usage";
const WHAM_TIMEOUT_MS = 15_000;

interface CodexCredential {
  path: string;
  email: string;
  accountId: string;
  accessToken: string;
}

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

interface CodexUsageShape {
  updatedAt: string;
  identity: { accountEmail: string; loginMethod?: string };
  primary?: { usedPercent: number; resetsAt: string | null; windowMinutes: number | null };
  secondary?: { usedPercent: number; resetsAt: string | null; windowMinutes: number | null };
}

type WhamFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LiveCodexAccounts {
  ok: RawCodexBarEntry[];
  emails: string[];
  failures: { email: string; detail: string }[];
}

function defaultDirs(): string[] {
  const home = Bun.env.HOME ?? "";
  return [`${home}/.cli-proxy-api`, `${home}/.cli-proxy-api-codex-plus`];
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

function readCredential(path: string): CodexCredential | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      type?: unknown;
      disabled?: unknown;
      email?: unknown;
      account_id?: unknown;
      access_token?: unknown;
    };
    if (parsed.type !== "codex" || parsed.disabled === true) return null;
    if (typeof parsed.email !== "string" || typeof parsed.account_id !== "string") return null;
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) return null;
    return { path, email: parsed.email, accountId: parsed.account_id, accessToken: parsed.access_token };
  } catch {
    return null;
  }
}

function listCredentials(dirs: string[]): CodexCredential[] {
  const out: CodexCredential[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const cred = readCredential(join(dir, name));
      if (!cred) continue;
      const key = cred.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cred);
    }
  }
  return out;
}

async function fetchWham(
  cred: CodexCredential,
  fetchImpl: WhamFetch,
): Promise<{ status: number; body: unknown | null }> {
  const res = await fetchImpl(WHAM_URL, {
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      "ChatGPT-Account-Id": cred.accountId,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(WHAM_TIMEOUT_MS),
  });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: await res.json() };
}

export async function readLiveCodexAccounts(opts?: {
  dirs?: string[];
  fetch?: WhamFetch;
  now?: () => string;
}): Promise<LiveCodexAccounts> {
  const fetchImpl = opts?.fetch ?? fetch;
  const observedAt = (opts?.now ?? (() => new Date().toISOString()))();
  const ok: RawCodexBarEntry[] = [];
  const emails: string[] = [];
  const failures: LiveCodexAccounts["failures"] = [];

  for (const initial of listCredentials(opts?.dirs ?? defaultDirs())) {
    try {
      let cred = initial;
      let result = await fetchWham(cred, fetchImpl);
      if (result.status === 401) {
        const reread = readCredential(cred.path);
        if (reread && reread.accessToken !== cred.accessToken) {
          cred = reread;
          result = await fetchWham(cred, fetchImpl);
        }
      }
      if (result.status !== 200 || result.body == null) {
        failures.push({ email: cred.email, detail: `HTTP ${result.status}` });
        continue;
      }
      ok.push(parseWhamUsage(result.body, { email: cred.email }, observedAt));
      emails.push(cred.email);
    } catch (e) {
      failures.push({
        email: initial.email,
        detail: e instanceof Error ? e.message : "fetch failed",
      });
    }
  }
  return { ok, emails, failures };
}
