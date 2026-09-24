/**
 * The usage view: every decision about what a usage row says, which account it belongs
 * to, and where it sits. `ccs usage`, the macOS menu bar (through JavaScriptCore), and the
 * hub's Fleet page all read this one file and only draw its output.
 *
 * Plain ECMAScript with no imports, so it runs unchanged in Bun, a browser, and
 * JavaScriptCore. Times cross the boundary as epoch milliseconds.
 */

/** The loose shape of `ccs usage --json`: optional where the hub's stored copies vary. */
export interface Observation {
  provider: string;
  entitlement: string;
  metric: string;
  window?: string | null;
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  resetsAt?: string | null;
  expiresAt?: string | null;
  observedAt?: string | null;
  exact?: boolean | null;
  stale?: boolean | null;
  tier?: string | null;
}

export interface Adapter {
  provider: string;
  status: string;
  detail?: string | null;
}

export interface Subscription {
  provider: string;
  account?: string | null;
  planName: string;
  monthlyDollars: number;
  renewsOn?: string | null;
}

export interface Snapshot {
  generatedAt?: string | null;
  observations: Observation[];
  adapters?: Adapter[] | null;
  subscriptions?: Subscription[] | null;
}

export interface Segment {
  name: string;
  fractionUsed: number | null;
}

export type Row =
  | { kind: "allowance"; id: string; label: string; window: string | null; fractionUsed: number | null;
      resetsAt: number | null; stale: boolean; observedAt: number | null; segments: Segment[] }
  | { kind: "credit"; id: string; label: string; balance: number; unit: "USD" | "credits"; resetsAt: number | null }
  | { kind: "reset"; id: string; label: string; available: boolean; expiresAt: number | null };

export interface Plan {
  name: string;
  dollars: number;
}

export interface Section {
  /** `provider|account`, the key saved section orders use. */
  id: string;
  provider: string;
  title: string;
  account: string | null;
  plan: Plan | null;
  renewsOn: string | null;
  rows: Row[];
  /** Epoch ms of the oldest stale reading in the section, when any. */
  staleSince: number | null;
}

export interface View {
  sections: Section[];
  /** Dollar-weighted used fraction (0...1) across accounts; null when nothing reports. */
  overall: { fiveHour: number | null; sevenDay: number | null };
  bill: { total: number; planCount: number };
  notes: string[];
}

export const providerTitle: Record<string, string> = { anthropic: "Claude", codex: "Codex", grok: "Grok" };

const windowShort: Record<string, string> = { five_hour: "5h", daily: "day", weekly: "wk", monthly: "mo", minute: "min" };
const windowRank: Record<string, number> = { "5h": 0, day: 1, wk: 2, mo: 3 };
const baseLabel: Record<string, string> = {
  "claude-max": "All models",
  "codex-pro": "All models",
  "codex-spark": "Spark",
  "codex-spark-weekly": "Spark weekly",
  "grok-super grok plus": "All usage",
};
const productLabel: Record<string, string> = {
  build: "Build", chat: "Chat", imagine: "Imagine", api: "API", prepaid: "Extra credits", reset: "Usage reset",
};

/** Dollars that weight an account whose plan is unknown in the overall reading. */
const FALLBACK_DOLLARS = 50;

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "claude-max:a@b.c#Fable" → base "claude-max", account "a@b.c", product "Fable". */
export function entitlementParts(entitlement: string): { base: string; account: string | null; product: string | null } {
  const hash = entitlement.indexOf("#");
  const product = hash === -1 ? null : entitlement.slice(hash + 1);
  const body = hash === -1 ? entitlement : entitlement.slice(0, hash);
  const colon = body.indexOf(":");
  const account = colon === -1 ? null : body.slice(colon + 1) || null;
  return { base: colon === -1 ? body : body.slice(0, colon), account, product };
}

function rowLabel(o: Observation): string {
  const { base, product } = entitlementParts(o.entitlement);
  if (product) return productLabel[product.toLowerCase()] ?? product.charAt(0).toUpperCase() + product.slice(1);
  if (o.metric === "reset_credit") return "Banked reset";
  return baseLabel[base.toLowerCase()] ?? base;
}

function fraction(o: Observation): number | null {
  if (o.used == null || o.limit == null || o.limit <= 0) return null;
  return Math.min(Math.max(o.used / o.limit, 0), 1);
}

/** Claude reports its tier on every row, so an unconfigured Claude account still names its plan. */
export function planFromTier(tier: string | null | undefined): Plan | null {
  const value = (tier ?? "").toLowerCase();
  if (!value) return null;
  if (value.includes("max_20") || value.includes("max 20")) return { name: "Max 20x", dollars: 200 };
  if (value.includes("max_5") || value.includes("max 5")) return { name: "Max 5x", dollars: 100 };
  if (value.includes("pro") || value === "default_claude_ai") return { name: "Pro", dollars: 20 };
  if (value.includes("max")) return { name: "Max", dollars: 100 };
  return null;
}

function toRow(o: Observation): Row | null {
  const id = `${o.provider}|${o.entitlement}|${o.window ?? ""}`;
  switch (o.metric) {
    case "allowance":
      return {
        kind: "allowance", id, label: rowLabel(o),
        window: o.window ? windowShort[o.window] ?? o.window : null,
        fractionUsed: fraction(o), resetsAt: ms(o.resetsAt), stale: o.stale === true,
        observedAt: ms(o.observedAt), segments: [],
      };
    case "credit":
      return o.remaining == null ? null : {
        kind: "credit", id: `credit|${o.provider}|${o.entitlement}`, label: rowLabel(o),
        balance: o.remaining, unit: o.entitlement.includes("usd") || o.entitlement.includes("dollar") || o.entitlement.includes("prepaid") ? "USD" : "credits",
        resetsAt: ms(o.resetsAt),
      };
    case "reset_credit": {
      const expiresAt = ms(o.expiresAt ?? o.resetsAt);
      return {
        kind: "reset", id: `reset|${o.provider}|${o.entitlement}|${expiresAt ?? ""}`, label: "Banked reset",
        available: o.remaining === 1, expiresAt,
      };
    }
    default:
      return null;
  }
}

/** The allowance id a `#product` row nests under: the same id without the product. */
function parentId(row: Row): string | null {
  const hash = row.id.indexOf("#");
  const lastPipe = row.id.lastIndexOf("|");
  return hash !== -1 && hash < lastPipe ? row.id.slice(0, hash) + row.id.slice(lastPipe) : null;
}

/**
 * Grok's Build/Chat/Imagine rows are shares of one pool, so they become segments of their
 * parent's bar. Claude's #Fable is its own cap and stays a row.
 */
function foldSegments(rows: Row[], provider: string): Row[] {
  if (provider !== "grok") return rows;
  const byId = new Map(rows.map(r => [r.id, r]));
  const folded = new Set<string>();
  for (const r of rows) {
    const pid = parentId(r);
    const parent = pid ? byId.get(pid) : undefined;
    if (r.kind !== "allowance" || parent?.kind !== "allowance") continue;
    parent.segments.push({ name: r.label, fractionUsed: r.fractionUsed });
    folded.add(r.id);
  }
  for (const r of rows) if (r.kind === "allowance") r.segments.sort((a, b) => (b.fractionUsed ?? 0) - (a.fractionUsed ?? 0));
  return rows.filter(r => !folded.has(r.id));
}

/** A snapshot can repeat an entitlement; ids stay unique so saved orders and list keys hold. */
function uniqueIds(rows: Row[]): Row[] {
  const seen = new Map<string, number>();
  return rows.map(r => {
    const n = seen.get(r.id) ?? 0;
    seen.set(r.id, n + 1);
    return n === 0 ? r : { ...r, id: `${r.id}~${n}` };
  });
}

/** Natural row order: by window, shortest first; rows without a window after. */
function rowRank(r: Row): number {
  if (r.kind !== "allowance" || !r.window) return 99;
  return windowRank[r.window] ?? 50;
}

/**
 * A provider ccs could not reach this run keeps its previous rows, marked stale, so one
 * failed adapter never blanks its section. observedAt stays the original fetch time.
 */
export function carryForward(next: Snapshot, previous: Snapshot | null | undefined): Snapshot {
  if (!previous) return next;
  const reporting = new Set(next.observations.map(o => o.provider));
  const unreachable = new Set((next.adapters ?? []).filter(a => a.status === "unavailable").map(a => a.provider));
  const carried = previous.observations
    .filter(o => unreachable.has(o.provider) && !reporting.has(o.provider))
    .map(o => ({ ...o, stale: true }));
  return carried.length === 0 ? next : { ...next, observations: [...next.observations, ...carried] };
}

/** Items in a saved order; items the order doesn't name keep their natural order after it. */
export function ordered<T>(items: T[], order: readonly string[] | undefined, id: (item: T) => string): T[] {
  if (!order || order.length === 0) return items;
  const rank = new Map<string, number>();
  order.forEach((key, i) => { if (!rank.has(key)) rank.set(key, i); });
  return items
    .map((item, i) => ({ item, i, r: rank.get(id(item)) ?? order.length }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.item);
}

/** Drops `moving` onto `target`: before it when dragged up, after it when dragged down. */
export function reordered(ids: readonly string[], moving: string, target: string): string[] {
  const from = ids.indexOf(moving);
  const to = ids.indexOf(target);
  if (moving === target || from === -1 || to === -1) return [...ids];
  const next = ids.filter(id => id !== moving);
  next.splice(to, 0, moving);
  return next;
}

export interface Order {
  sections?: readonly string[];
  /** Row ids per section id. */
  rows?: Readonly<Record<string, readonly string[]>>;
}

function overallReading(sections: Section[]): View["overall"] {
  let five = 0, fiveW = 0, seven = 0, sevenW = 0;
  for (const s of sections) {
    const allowances = s.rows.filter((r): r is Extract<Row, { kind: "allowance" }> =>
      r.kind === "allowance" && r.fractionUsed != null && !parentId(r));
    const weekly = allowances.find(r => r.window === "wk")?.fractionUsed ?? null;
    const fiveHour = allowances.find(r => r.window === "5h")?.fractionUsed ?? null;
    const dollars = s.plan?.dollars ?? FALLBACK_DOLLARS;
    // A 5h cap can't outspend the weekly pool, and a plan without one falls through to it.
    const f = Math.max(fiveHour ?? -1, weekly ?? -1);
    if (f >= 0) { five += f * dollars; fiveW += dollars; }
    if (weekly != null) { seven += weekly * dollars; sevenW += dollars; }
  }
  return { fiveHour: fiveW > 0 ? five / fiveW : null, sevenDay: sevenW > 0 ? seven / sevenW : null };
}

export function buildView(snapshot: Snapshot, order: Order = {}): View {
  const groups = new Map<string, { provider: string; account: string | null; obs: Observation[] }>();
  // Only drawable metrics form sections, so an unknown metric (Venice's per-model rate
  // limits from an older ccs) cannot mint hundreds of empty sections.
  for (const o of snapshot.observations) {
    if (toRow(o) === null) continue;
    const account = entitlementParts(o.entitlement).account;
    const id = `${o.provider}|${account ?? ""}`;
    if (!groups.has(id)) groups.set(id, { provider: o.provider, account, obs: [] });
    groups.get(id)!.obs.push(o);
  }
  // Provider-level rows with no account join that provider's sole named account.
  for (const [id, g] of [...groups]) {
    if (g.account) continue;
    const named = [...groups.values()].filter(x => x.provider === g.provider && x.account);
    if (named.length === 1) { named[0]!.obs.push(...g.obs); groups.delete(id); }
  }
  const subscriptions = new Map((snapshot.subscriptions ?? []).map(s => [`${s.provider}|${s.account ?? ""}`, s]));
  for (const [id, s] of subscriptions) {
    if (!groups.has(id)) groups.set(id, { provider: s.provider, account: s.account ?? null, obs: [] });
  }

  const sections: Section[] = [...groups].map(([id, g]) => {
    const rows = uniqueIds(g.obs.map(toRow).filter((r): r is Row => r !== null));
    const natural = foldSegments(rows, g.provider)
      .map((r, i) => ({ r, i }))
      .sort((a, b) => rowRank(a.r) - rowRank(b.r) || a.i - b.i)
      .map(x => x.r);
    const sub = subscriptions.get(id);
    const staleTimes = natural.flatMap(r => r.kind === "allowance" && r.stale && r.observedAt != null ? [r.observedAt] : []);
    return {
      id,
      provider: g.provider,
      title: providerTitle[g.provider] ?? g.provider,
      account: g.account,
      plan: sub ? { name: sub.planName, dollars: sub.monthlyDollars }
        : g.provider === "anthropic" ? planFromTier(g.obs.find(o => o.tier)?.tier) : null,
      renewsOn: sub?.renewsOn ?? null,
      rows: ordered(natural, order.rows?.[id], r => r.id),
      staleSince: staleTimes.length ? Math.min(...staleTimes) : null,
    };
  });

  const withPlan = sections.filter(s => s.plan);
  return {
    sections: ordered(sections, order.sections, s => s.id),
    overall: overallReading(sections),
    bill: { total: withPlan.reduce((sum, s) => sum + s.plan!.dollars, 0), planCount: withPlan.length },
    notes: (snapshot.adapters ?? []).filter(a => a.status !== "ok")
      .map(a => `${providerTitle[a.provider] ?? a.provider}: ${a.detail ?? a.status}`),
  };
}

/** "12m" / "5h" / "3d": the age of a timestamp, for stale badges and footers. */
export function shortAge(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** "Oct 8" from a `YYYY-MM-DD` renewal date, read in UTC so it never shifts a day. */
export function renewalLabel(renewsOn: string): string {
  const t = Date.parse(`${renewsOn}T00:00:00Z`);
  if (Number.isNaN(t)) return renewsOn;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(t);
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
