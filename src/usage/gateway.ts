/**
 * The CLIProxyAPI gateway's management API: the one place `ccs usage` gets credentials.
 *
 * Every Claude and Codex login lives on the gateway. Upstream usage endpoints are reached
 * through `POST /api-call`, which substitutes the credential's token for `$TOKEN$` server-side,
 * so no token ever reaches this process and a Mac with no local login still reads every account.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayAccount, ProviderId } from "./types.ts";

const DEFAULT_BASE = "http://milads-mac-mini.taild31e9a.ts.net:8450";
const LOCAL_FALLBACKS = ["http://127.0.0.1:8318", "http://127.0.0.1:8317"];
const PROBE_TIMEOUT_MS = 3_000;
const CALL_TIMEOUT_MS = 20_000;

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GatewayCredential {
  authIndex: string;
  provider: string;
  email: string;
  disabled: boolean;
  /** Higher is preferred. The gateway treats an unset priority as 0. */
  priority: number;
  status: string;
  statusMessage: string | null;
  unavailable: boolean;
  nextRetryAfter: string | null;
  /** Codex only: the ChatGPT account the usage endpoint is scoped to. */
  chatgptAccountId: string | null;
}

export interface CallOptions {
  method?: "GET" | "POST";
  /** Request body as a string; the gateway sends it verbatim. */
  data?: string;
}

/** `body` is parsed JSON when the upstream sent JSON, else the raw text, and null on a non-200. */
export interface CallResult {
  status: number;
  body: unknown;
  retryAfter?: string | null;
}

export interface Gateway {
  base: string;
  credentials: GatewayCredential[];
  call(authIndex: string, url: string, header: Record<string, string>, opts?: CallOptions): Promise<CallResult>;
}

export function gatewayBases(env: Record<string, string | undefined> = Bun.env): string[] {
  return [...new Set([env.CLI_PROXY_MGMT_URL || DEFAULT_BASE, ...LOCAL_FALLBACKS])];
}

export function parseAuthFiles(payload: unknown): GatewayCredential[] {
  const files = (payload as { files?: unknown })?.files;
  if (!Array.isArray(files)) return [];
  const out: GatewayCredential[] = [];
  for (const row of files) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.auth_index !== "string" || typeof r.email !== "string" || !r.email) continue;
    const idToken = r.id_token as { chatgpt_account_id?: unknown } | undefined;
    out.push({
      authIndex: r.auth_index,
      provider: String(r.provider ?? r.type ?? "").toLowerCase(),
      email: r.email,
      disabled: r.disabled === true,
      priority: typeof r.priority === "number" ? r.priority : 0,
      status: typeof r.status === "string" ? r.status : "unknown",
      statusMessage: typeof r.status_message === "string" && r.status_message ? r.status_message : null,
      unavailable: r.unavailable === true,
      nextRetryAfter: typeof r.next_retry_after === "string" ? r.next_retry_after : null,
      chatgptAccountId: typeof idToken?.chatgpt_account_id === "string" ? idToken.chatgpt_account_id : null,
    });
  }
  return out;
}

/** Why a credential cannot serve right now, or null when it can. Disabled is a routing choice, not an issue. */
export function credentialIssue(c: GatewayCredential): string | null {
  if (c.nextRetryAfter) return `gateway: cooling down until ${c.nextRetryAfter}`;
  if (c.unavailable || c.status === "error") return `gateway: ${c.statusMessage ?? c.status} (needs cliproxyapi -claude-login)`;
  return null;
}

/**
 * The gateway's routing view per provider. Fill-first picks from the highest-priority tier of
 * serving credentials; within a tier it takes the first listed.
 * ponytail: ties resolve to listing order, which matches fill-first but ignores session affinity.
 */
export function gatewayAccounts(credentials: GatewayCredential[], providers: readonly ProviderId[]): GatewayAccount[] {
  const wanted = credentials.filter((c) => (providers as readonly string[]).includes(provider(c)));
  const first = new Map<string, GatewayCredential>();
  for (const c of wanted) {
    if (c.disabled || credentialIssue(c)) continue;
    const best = first.get(c.provider);
    if (!best || c.priority > best.priority) first.set(c.provider, c);
  }
  return wanted.map((c) => ({
    provider: provider(c),
    email: c.email,
    priority: c.priority,
    disabled: c.disabled,
    firstInLine: first.get(c.provider) === c,
  }));
}

/** The gateway calls Claude "claude"; ccs calls the provider "anthropic". */
function provider(c: GatewayCredential): string {
  return c.provider === "claude" ? "anthropic" : c.provider;
}

/** First base that answers `auth-files` wins. Null when none does, with the reason per base. */
export async function connectGateway(opts: {
  bases?: string[];
  key?: string | null;
  fetch?: Fetch;
} = {}): Promise<{ ok: true; gateway: Gateway } | { ok: false; detail: string }> {
  const key = opts.key !== undefined ? opts.key : readManagementKey();
  if (!key) return { ok: false, detail: "no management key at ~/.cli-proxy-api-management-key" };
  const fetchImpl = opts.fetch ?? fetch;
  const auth = { authorization: `Bearer ${key}` };
  const tried: string[] = [];
  for (const base of opts.bases ?? gatewayBases()) {
    const mgmt = `${base}/v0/management`;
    try {
      const res = await fetchImpl(`${mgmt}/auth-files`, { headers: auth, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!res.ok) { tried.push(`${base} HTTP ${res.status}`); continue; }
      const credentials = parseAuthFiles(await res.json());
      return {
        ok: true,
        gateway: {
          base,
          credentials,
          async call(authIndex, url, header, opts = {}) {
            if (Bun.env.CCS_USAGE_DEBUG) console.error(`ccs usage: api-call ${url}`);
            const r = await fetchImpl(`${mgmt}/api-call`, {
              method: "POST",
              headers: { ...auth, "content-type": "application/json" },
              body: JSON.stringify({ auth_index: authIndex, method: opts.method ?? "GET", url, header, data: opts.data }),
              signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            });
            if (!r.ok) return { status: r.status, body: null, retryAfter: null };
            const envelope = (await r.json()) as { status_code?: number; header?: Record<string, string[]>; body?: string };
            const status = envelope.status_code ?? 0;
            const retryAfter = headerValue(envelope.header, "retry-after");
            if (status !== 200) return { status, body: null, retryAfter };
            return { status, body: parseBody(envelope.body ?? ""), retryAfter };
          },
        },
      };
    } catch (e) {
      tried.push(`${base} ${e instanceof Error ? e.message : "unreachable"}`);
    }
  }
  return { ok: false, detail: `gateway unreachable: ${tried.join("; ")}` };
}

function headerValue(header: Record<string, string[]> | undefined, name: string): string | null {
  const key = Object.keys(header ?? {}).find((k) => k.toLowerCase() === name);
  return key ? header![key]?.[0] ?? null : null;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readManagementKey(): string | null {
  try {
    return readFileSync(join(homedir(), ".cli-proxy-api-management-key"), "utf8").trim() || null;
  } catch {
    return null;
  }
}
