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
 *  - POST https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets —
 *    redeemable usage-reset grants: token, available-since, expiry. gRPC-Web protobuf.
 */

import { readFileSync } from "node:fs";
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

export interface GrokResetGrant {
  /** Opaque redemption token — retained only to distinguish grants; never printed. */
  token: string;
  availableAt: string | null;
  expiresAt: string | null;
}

export interface GrokBilling {
  credits: GrokCreditsConfig;
  resets: GrokResetGrant[];
  /** Non-null when billing worked but the separate reset-grant RPC did not. */
  resetError: string | null;
  tier: string | null;
  email: string;
}

/** Read identity + token from ~/.grok/auth.json. Values never leave this module raw. */
function grokIdentity(): Result<{ key: string; userId: string; email: string }, AdapterHealth> {
  let auth: Record<string, { email?: string; key?: string; user_id?: string; expires_at?: string }>;
  try {
    auth = JSON.parse(readFileSync(`${process.env.HOME}/.grok/auth.json`, "utf8"));
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

function readVarint(buf: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = start;
  while (next < buf.length && shift <= 49) {
    const byte = buf[next++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next };
    shift += 7;
  }
  throw new Error("truncated or oversized protobuf varint");
}

function timestampMessage(buf: Uint8Array): string | null {
  if (buf.length === 0) return null;
  const key = readVarint(buf, 0);
  if (key.value !== 8) return null; // Timestamp.seconds = field 1, wire 0
  const seconds = readVarint(buf, key.next).value;
  return new Date(seconds * 1000).toISOString();
}

/** Decode ConsumerUiSvc.GetRemainingResets; schema observed from the real web UI. */
export function parseGrokResetGrants(frame: Uint8Array): GrokResetGrant[] {
  try {
    if (frame.length < 5 || frame[0] !== 0) return [];
    const payloadLength = new DataView(frame.buffer, frame.byteOffset + 1, 4).getUint32(0, false);
    if (payloadLength === 0 || payloadLength > frame.length - 5) return [];
    const payload = frame.subarray(5, 5 + payloadLength);
    const grants: GrokResetGrant[] = [];
    let outer = 0;
    while (outer < payload.length) {
      const key = readVarint(payload, outer);
      outer = key.next;
      const outerField = key.value >> 3;
      if ((key.value & 7) !== 2) return [];
      const len = readVarint(payload, outer);
      outer = len.next;
      if (len.value > payload.length - outer) return [];
      const grant = payload.subarray(outer, outer + len.value);
      outer += len.value;
      if (outerField !== 10) continue;
      let i = 0;
      let token = "";
      let availableAt: string | null = null;
      let expiresAt: string | null = null;
      while (i < grant.length) {
        const innerKey = readVarint(grant, i);
        i = innerKey.next;
        const field = innerKey.value >> 3;
        if ((innerKey.value & 7) !== 2) return [];
        const innerLen = readVarint(grant, i);
        i = innerLen.next;
        if (innerLen.value > grant.length - i) return [];
        const value = grant.subarray(i, i + innerLen.value);
        i += innerLen.value;
        if (field === 10) token = new TextDecoder().decode(value);
        else if (field === 20) availableAt = timestampMessage(value);
        else if (field === 30) expiresAt = timestampMessage(value);
      }
      if (token) grants.push({ token, availableAt, expiresAt });
    }
    return grants;
  } catch {
    return [];
  }
}

async function getRemainingResets(key: string, userId: string): Promise<GrokResetGrant[]> {
  const requestFrame = new Uint8Array(5); // gRPC-Web frame containing an empty protobuf message
  const res = await fetch("https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "x-userid": userId,
      "content-type": "application/grpc-web+proto",
      "x-grok-client-mode": "cli",
      "x-grok-client-version": "1.0.5",
    },
    body: requestFrame,
    signal: AbortSignal.timeout(GROK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GetRemainingResets HTTP ${res.status}`);
  const frame = new Uint8Array(await res.arrayBuffer());
  const trailerText = new TextDecoder().decode(frame.subarray(Math.max(0, frame.length - 64)));
  if (!trailerText.includes("grpc-status:0")) {
    throw new Error("GetRemainingResets returned a nonzero or missing gRPC status");
  }
  return parseGrokResetGrants(frame);
}

export async function fetchGrokBilling(): Promise<Result<GrokBilling, AdapterHealth>> {
  const id = grokIdentity();
  if (!id.ok) return err(id.error);
  const { key, userId, email } = id.value;
  try {
    const [credits, subs, resetResult] = await Promise.all([
      getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", key, userId) as Promise<GrokCreditsConfig>,
      getJson("https://grok.com/rest/subscriptions", key, userId).catch(() => null) as Promise<GrokSubscriptions | null>,
      getRemainingResets(key, userId)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: Error) => ({ ok: false as const, error })),
    ]);
    const active = subs?.subscriptions?.find((s) => s.status === "SUBSCRIPTION_STATUS_ACTIVE")?.tier;
    return ok({
      credits,
      resets: resetResult.ok ? resetResult.value : [],
      resetError: resetResult.ok ? null : resetResult.error.message,
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
