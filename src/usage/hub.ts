/**
 * The hub's copy of the gateway's usage reads. The Mini's collector is the only reader of the
 * providers' usage endpoints; every Mac reads its snapshot here, so `ccs usage` and the menu bars
 * add no calls against Anthropic's per-account rate limit.
 */
const DEFAULT_SITE = "https://usable-gopher-567.convex.site";
const READ_TOKEN_REF = "op://Sol/Hub Read/credential";
const TIMEOUT_MS = 5_000;
/** The collector posts every five minutes, so a snapshot older than two runs means it has stopped. */
export const HUB_FRESH_MS = 10 * 60_000;

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HubWindow {
  usedPct: number;
  resetsAt: string | null;
}

/** One credential as convex/modules/gateway.ts in the hub repo defines it. */
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
  usageError: string | null;
  locked: boolean;
  windows: { fiveHour: HubWindow | null; weekly: HubWindow | null; fable: HubWindow | null };
  bankedResets: { count: number; nextExpiresAt: string | null } | null;
  /** When these numbers were read upstream. Older than collectedAt when the collector carried them forward. */
  usageObservedAt?: number | null;
}

export interface HubSnapshot {
  collectedAt: number;
  credentials: HubCredential[];
}

export type HubRead = { ok: true; site: string; snapshot: HubSnapshot } | { ok: false; detail: string };

export async function readHubSnapshot(opts: {
  site?: string;
  token?: string | null;
  fetch?: Fetch;
} = {}): Promise<HubRead> {
  const site = opts.site ?? (Bun.env.HUB_SITE || DEFAULT_SITE);
  const token = opts.token !== undefined ? opts.token : await readToken();
  if (!token) return { ok: false, detail: `no hub read token (HUB_READ_TOKEN or ${READ_TOKEN_REF})` };
  try {
    const res = await (opts.fetch ?? fetch)(`${site}/gateway`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, detail: `hub /gateway HTTP ${res.status}` };
    const snapshot = (await res.json()) as HubSnapshot | null;
    if (!snapshot || !Array.isArray(snapshot.credentials)) return { ok: false, detail: "hub has no gateway snapshot" };
    return { ok: true, site, snapshot };
  } catch (e) {
    return { ok: false, detail: `hub unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Fresh enough to stand in for an upstream read. */
export function hubFresh(read: HubRead, now: number): read is Extract<HubRead, { ok: true }> {
  return read.ok && now - read.snapshot.collectedAt < HUB_FRESH_MS;
}

async function readToken(): Promise<string | null> {
  if (Bun.env.HUB_READ_TOKEN) return Bun.env.HUB_READ_TOKEN;
  try {
    const proc = Bun.spawn(["op", "read", READ_TOKEN_REF], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const out = (await new Response(proc.stdout).text()).trim();
    clearTimeout(timer);
    return (await proc.exited) === 0 && out ? out : null;
  } catch {
    return null;
  }
}
