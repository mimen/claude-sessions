/**
 * The hub's copy of every provider usage read. The Mini's collector is the only caller of the
 * providers' usage endpoints; every Mac reads its snapshot here and never calls a provider itself.
 * When the hub cannot answer, the last snapshot this Mac saw is read from disk instead.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runtimeRoot } from "../paths.ts";

export const HUB_SITE = "https://usable-gopher-567.convex.site";
const TIMEOUT_MS = 5_000;
/** The collector posts every five minutes, so a snapshot older than two runs means it has stopped. */
export const HUB_FRESH_MS = 10 * 60_000;

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HubWindow {
  usedPct: number;
  resetsAt: string | null;
}

/** One credential as convex/modules/gateway.ts in the hub repo defines it. Newer fields are optional. */
export interface HubCredential {
  name: string;
  authIndex: string;
  provider: string;
  email: string | null;
  disabled: boolean;
  priority: number | null;
  status: string;
  statusMessage: string | null;
  unavailable: boolean;
  plan: string | null;
  renewsAt: string | null;
  /** Codex: renewsAt was rolled forward from an old token date, not read from billing. */
  renewsAtEstimated?: boolean;
  usageError: string | null;
  locked: boolean;
  windows: { fiveHour: HubWindow | null; weekly: HubWindow | null; fable: HubWindow | null };
  /** `expiries` lists one ISO time per available reset, ascending. */
  bankedResets: { count: number; nextExpiresAt: string | null; expiries?: string[] } | null;
  /** xai: shares of the weekly pool by product, e.g. "GrokBuild". */
  productUsage?: { product: string; usedPct: number }[];
  /** xai: prepaid extra-usage credit in dollars. */
  prepaidUsd?: number;
  /** When these numbers were read upstream. Older than collectedAt when the collector carried them forward. */
  usageObservedAt?: number | null;
}

export interface HubSnapshot {
  collectedAt: number;
  credentials: HubCredential[];
}

/** `unreachable` is set when the snapshot came from this Mac's cache because the hub did not answer. */
export type HubRead =
  | { ok: true; site: string; snapshot: HubSnapshot; unreachable?: string }
  | { ok: false; detail: string };

export const hubCachePath = () => join(runtimeRoot(), "cache", "hub-gateway.json");

export async function readHubSnapshot(opts: {
  site?: string;
  token?: string | null;
  fetch?: Fetch;
  cachePath?: string;
} = {}): Promise<HubRead> {
  const site = opts.site ?? (Bun.env.HUB_SITE || HUB_SITE);
  const cachePath = opts.cachePath ?? hubCachePath();
  const live = await fetchSnapshot(site, opts.token !== undefined ? opts.token : await readHubToken("read"), opts.fetch ?? fetch);
  if ("snapshot" in live) {
    writeCache(cachePath, live.snapshot);
    return { ok: true, site, snapshot: live.snapshot };
  }
  const cached = readCache(cachePath);
  return cached ? { ok: true, site, snapshot: cached, unreachable: live.detail } : { ok: false, detail: live.detail };
}

async function fetchSnapshot(site: string, token: string | null, fetchImpl: Fetch): Promise<{ snapshot: HubSnapshot } | { detail: string }> {
  if (!token) return { detail: `no hub read token (${tokenFile("read")}, HUB_READ_TOKEN, or op)` };
  try {
    const res = await fetchImpl(`${site}/gateway`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { detail: `hub /gateway HTTP ${res.status}` };
    const snapshot = (await res.json()) as HubSnapshot | null;
    if (!snapshot || !Array.isArray(snapshot.credentials)) return { detail: "hub has no gateway snapshot" };
    return { snapshot };
  } catch (e) {
    return { detail: `hub unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function readCache(path: string): HubSnapshot | null {
  try {
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as HubSnapshot;
    return Array.isArray(snapshot.credentials) ? snapshot : null;
  } catch {
    return null;
  }
}

function writeCache(path: string, snapshot: HubSnapshot): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(snapshot));
    renameSync(`${path}.tmp`, path);
  } catch {}
}

export type HubTokenKind = "read" | "ingest";

export const tokenFile = (kind: HubTokenKind, home = homedir()) => join(home, ".config/ccs", `hub-${kind}-token`);
export const tokenRef = (kind: HubTokenKind) => `op://Sol/${kind === "read" ? "Hub Read" : "Hub Ingest"}/credential`;

/** The token file the install writes, then the environment, then a bounded `op read`. */
export async function readHubToken(kind: HubTokenKind, home = homedir()): Promise<string | null> {
  try {
    const token = readFileSync(tokenFile(kind, home), "utf8").trim();
    if (token) return token;
  } catch {}
  const env = kind === "read" ? Bun.env.HUB_READ_TOKEN : Bun.env.HUB_INGEST_TOKEN;
  if (env) return env;
  try {
    // Under launchd (the menu bar) op hangs probing the desktop app unless told not to.
    const proc = Bun.spawn(["op", "read", tokenRef(kind)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...Bun.env, OP_LOAD_DESKTOP_APP_SETTINGS: "false" },
    });
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const out = (await new Response(proc.stdout).text()).trim();
    clearTimeout(timer);
    return (await proc.exited) === 0 && out ? out : null;
  } catch {
    return null;
  }
}
