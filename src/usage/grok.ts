/**
 * Grok consumer subscription billing, read from xAI's own surfaces through the gateway's
 * xAI credential, or with the OIDC token in ~/.grok/auth.json when the gateway has none.
 *
 * Endpoints (verified live 2026-08-22):
 *  - GET https://cli-chat-proxy.grok.com/v1/billing?format=credits — weekly usage
 *    percent, product breakdown (GrokBuild/GrokChat/GrokImagine), prepaid balance,
 *    current period start/end. JSON.
 *  - GET https://grok.com/rest/subscriptions — active plan tier
 *    (e.g. SUBSCRIPTION_TIER_SUPER_GROK_PLUS). JSON.
 *  - POST https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets —
 *    redeemable usage-reset grants: token, available-since, expiry. gRPC-Web protobuf.
 * All three answer through the gateway's api-call (verified 2026-10-02).
 */

import { readFileSync } from "node:fs";
import { err, ok, type Result } from "../result.ts";
import type { Gateway } from "./gateway.ts";
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
  subscriptions?: Array<{ tier?: string; status?: string; billingPeriodEnd?: string }>;
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
  renewsAt: string | null;
  email: string;
}

export function activeGrokSubscription(subscriptions: GrokSubscriptions | null): {
  tier: string | null;
  renewsAt: string | null;
} {
  const active = subscriptions?.subscriptions?.find((subscription) =>
    subscription.status === "SUBSCRIPTION_STATUS_ACTIVE"
      && subscription.tier?.startsWith("SUBSCRIPTION_TIER_")
      && subscription.billingPeriodEnd,
  ) ?? subscriptions?.subscriptions?.find((subscription) =>
    subscription.status === "SUBSCRIPTION_STATUS_ACTIVE"
      && subscription.tier?.startsWith("SUBSCRIPTION_TIER_"),
  );
  return {
    tier: active?.tier
      ? active.tier.replace("SUBSCRIPTION_TIER_", "").replaceAll("_", " ").toLowerCase()
      : null,
    renewsAt: active?.billingPeriodEnd ?? null,
  };
}

/** One upstream request; the transport adds the credential. Body is JSON when parseable, else text. */
export type GrokCall = (url: string, opts?: { method?: "POST"; data?: string; contentType?: string }) =>
  Promise<{ status: number; body: unknown }>;

/** What the Grok CLI sends; the billing proxy rejects unknown clients. */
const CLIENT_HEADERS = { "x-grok-client-version": "1.0.44", "User-Agent": "xai-grok-workspace/1.0.44" };

/** Through the gateway's xAI credential: the token stays on the gateway and the gateway refreshes it. */
export function gatewayGrokCall(gateway: Gateway, authIndex: string): GrokCall {
  return async (url, opts = {}) => {
    const res = await gateway.call(authIndex, url, {
      Authorization: "Bearer $TOKEN$",
      ...CLIENT_HEADERS,
      ...(opts.contentType ? { "content-type": opts.contentType, accept: opts.contentType } : {}),
    }, { method: opts.method, data: opts.data });
    return { status: res.status, body: res.body };
  };
}

/** Last resort: the OIDC token `grok login` wrote to ~/.grok/auth.json on this Mac. */
export function localGrokCall(): Result<{ call: GrokCall; email: string }, AdapterHealth> {
  let auth: Record<string, { email?: string; key?: string; user_id?: string; expires_at?: string }>;
  try {
    auth = JSON.parse(readFileSync(`${process.env.HOME}/.grok/auth.json`, "utf8"));
  } catch {
    return err({ provider: "grok", status: "unavailable", detail: "no xAI credential on the gateway and ~/.grok/auth.json unreadable" });
  }
  const entry = Object.entries(auth)
    .filter(([k]) => k.startsWith("https://auth.x.ai::"))
    .map(([, v]) => v)
    .find((v) => v.key && (!v.expires_at || Date.parse(v.expires_at) > Date.now()));
  if (!entry?.key || !entry.user_id) {
    return err({ provider: "grok", status: "unavailable", detail: "no xAI credential on the gateway and no unexpired local grok token" });
  }
  const { key, user_id: userId } = entry;
  const call: GrokCall = async (url, opts = {}) => {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "x-userid": userId,
        ...CLIENT_HEADERS,
        ...(opts.contentType ? { "content-type": opts.contentType, accept: opts.contentType } : {}),
      },
      body: opts.data,
      signal: AbortSignal.timeout(GROK_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) return { status: res.status, body: null };
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  };
  return ok({ call, email: entry.email ?? "unknown" });
}

async function getJson(call: GrokCall, url: string): Promise<unknown> {
  const res = await call(url);
  if (res.status !== 200 || res.body == null) throw new Error(`${url.split("grok.com")[1]} HTTP ${res.status}`);
  return res.body;
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

/**
 * gRPC-Web text mode: base64 frames both ways, so the call survives the gateway's string body.
 * The response is the data frame and the trailer frame, each base64-encoded on its own.
 */
async function getRemainingResets(call: GrokCall): Promise<GrokResetGrant[]> {
  const res = await call("https://grok.com/prod_mc_billing.ConsumerUiSvc/GetRemainingResets", {
    method: "POST",
    data: "AAAAAAA=", // an empty protobuf message in one gRPC-Web frame
    contentType: "application/grpc-web-text",
  });
  if (res.status !== 200 || typeof res.body !== "string") throw new Error(`GetRemainingResets HTTP ${res.status}`);
  const frames = (res.body.match(/[A-Za-z0-9+/]+=*/g) ?? []).map((chunk) => Uint8Array.from(Buffer.from(chunk, "base64")));
  const trailer = frames.find((f) => f[0] === 0x80);
  if (!trailer || !new TextDecoder().decode(trailer).includes("grpc-status:0")) {
    throw new Error("GetRemainingResets returned a nonzero or missing gRPC status");
  }
  return frames.filter((f) => f[0] === 0).flatMap(parseGrokResetGrants);
}

export async function fetchGrokBilling(call: GrokCall, email: string): Promise<Result<GrokBilling, AdapterHealth>> {
  try {
    const [credits, subs, resetResult] = await Promise.all([
      getJson(call, "https://cli-chat-proxy.grok.com/v1/billing?format=credits") as Promise<GrokCreditsConfig>,
      getJson(call, "https://grok.com/rest/subscriptions").catch(() => null) as Promise<GrokSubscriptions | null>,
      getRemainingResets(call)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: Error) => ({ ok: false as const, error })),
    ]);
    const active = activeGrokSubscription(subs);
    return ok({
      credits,
      resets: resetResult.ok ? resetResult.value : [],
      resetError: resetResult.ok ? null : resetResult.error.message,
      tier: active.tier,
      renewsAt: active.renewsAt,
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
