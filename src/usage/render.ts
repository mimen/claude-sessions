/**
 * Terminal rendering for `ccs usage`. The view groups by platform + account, one block
 * per subscription with aligned limit rows beneath it — bars line up across the whole
 * run. Unknowns state themselves plainly; quota kinds never merge into one percentage.
 */

import type { UsageObservation, UsageSnapshot } from "./types.ts";
import { formatCost } from "../cost.ts";

/** Sort key: running out first, then expiring credits, then everything else. */
function urgency(o: UsageObservation): number {
  if (o.metric === "reset_credit" && o.expiresAt) return 1;
  if (o.remaining !== null && o.limit !== null && o.limit > 0 && o.used !== null) {
    const frac = o.used / o.limit;
    if (frac >= 0.99) return 0;
    if (frac >= 0.7) return 1;
  }
  return 2;
}

const WINDOW_LABEL: Record<string, string> = {
  minute: "per-minute",
  five_hour: "five-hour",
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
};

const PROVIDER_TITLE: Record<string, string> = {
  codex: "Codex",
  anthropic: "Claude",
  grok: "Grok",
  "opencode-go": "OpenCode Go",
  venice: "Venice",
};

const ENTITLEMENT_LABEL: Record<string, string> = {
  "codex-spark": "Spark",
  "codex-spark-weekly": "Spark weekly",
};

/** Entitlement id without any ":<account>" or "#<product>" suffix. */
function baseEntitlement(entitlement: string): string {
  const cut = Math.min(
    ...["#", ":"].map((c) => { const i = entitlement.indexOf(c); return i === -1 ? entitlement.length : i; })
  );
  return entitlement.slice(0, cut);
}

/** Product sub-row qualifier: the part after "#", when present. */
function productOf(entitlement: string): string | null {
  const i = entitlement.indexOf("#");
  return i === -1 ? null : entitlement.slice(i + 1);
}

const PRODUCT_LABEL: Record<string, string> = {
  build: "Grok Build",
  chat: "Grok Chat",
  imagine: "Imagine",
  api: "API",
  reset: "Usage reset",
  prepaid: "Extra credits",
};

/** Short limit name shown under a provider/account group. */
function limitName(o: UsageObservation): string {
  const product = productOf(o.entitlement);
  if (product) {
    const named = PRODUCT_LABEL[product.toLowerCase()];
    if (named) return named;
  }
  const base = baseEntitlement(o.entitlement);
  const override = ENTITLEMENT_LABEL[base];
  if (override) return override;
  switch (o.metric) {
    case "reset_credit": return "banked reset";
    case "credit":
      if (base.includes("diem")) return "DIEM balance";
      if (base.includes("usd")) return "USD balance";
      return "dollar credits";
    case "rate_limit": return "per-model RPM";
    case "allowance":
      return o.window ? (WINDOW_LABEL[o.window] ?? "allowance") : "allowance";
    default: return base;
  }
}

/** Account qualifier: the part after ":" (before any "#") in a multi-account entitlement. */
function accountOf(o: UsageObservation): string | null {
  const stripped = o.entitlement.split("#")[0] ?? o.entitlement;
  const i = stripped.indexOf(":");
  return i === -1 ? null : stripped.slice(i + 1);
}

/** Group key: platform + account; rate-limit caps fold into the plain provider group. */
function groupKey(o: UsageObservation): string {
  if (o.metric === "rate_limit") return o.provider;
  const acct = accountOf(o);
  return acct ? `${o.provider}:${acct}` : o.provider;
}

function groupTitle(provider: string, account: string | null): string {
  const base = PROVIDER_TITLE[provider] ?? provider;
  return account ? `${base} · ${account}` : base;
}

/**
 * An eight-segment usage bar, e.g. `███████░`. Filled segments scale with use.
 */
export function bar(usedPct: number | null, width = 8): string {
  if (usedPct === null) return "─".repeat(width);
  const filled = Math.min(width, Math.max(0, Math.round((usedPct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** ANSI colors keyed to how full a window is — green under 70, amber under 90, red past that. */
function colorFor(pct: number | null, s: string): string {
  if (!process.stdout.isTTY || pct === null) return s;
  const c = pct >= 90 ? "\x1b[31m" : pct >= 70 ? "\x1b[33m" : "\x1b[32m";
  return `${c}${s}\x1b[0m`;
}

/** "in 4h 12m"-style countdown from now; empty string when unparseable. */
export function countdown(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const ms = t - Date.now();
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 48) return `in ${h}h ${rem}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

/** "Aug 25 13:59" style short timestamp; falls back to the raw ISO when unparseable. */
export function shortReset(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** Credit rendering is currency-aware: DIEM is not dollars. */
function creditAmount(entitlement: string, remaining: number | null): string {
  if (remaining === null) return "?";
  const base = baseEntitlement(entitlement);
  if (base.includes("diem")) return `${remaining} DIEM`;
  return remaining === 0 ? "$0" : formatCost(remaining);
}

interface Group {
  provider: string;
  account: string | null;
  title: string;
  rows: Array<{ obs: UsageObservation; name: string; attention: boolean }>;
}

/** Column width so limit names align within their group blocks. */
function layoutWidths(groups: Group[]): { limitPad: number } {
  let maxLimit = 6;
  for (const g of groups) for (const r of g.rows) maxLimit = Math.max(maxLimit, r.name.length);
  return { limitPad: Math.min(maxLimit, 18) };
}

export function renderSnapshot(snap: UsageSnapshot): string {
  const lines: string[] = [];

  // Per-model rate-limit caps are reference data — collapse to ONE summary observation
  // before grouping, so the view stays a screen; --json still carries every entry.
  const caps = snap.observations.filter((o) => o.metric === "rate_limit");
  const rest = snap.observations.filter((o) => o.metric !== "rate_limit");
  let observations = rest;
  let capSummary: string | null = null;
  if (caps.length) {
    const lo = Math.min(...caps.map((o) => o.limit ?? Infinity));
    const hi = Math.max(...caps.map((o) => o.limit ?? 0));
    capSummary = `${caps.length} models · ${lo}–${hi} req/min (detail in --json)`;
    observations = [...rest, {
      provider: "venice" as const,
      entitlement: "venice-model-caps",
      metric: "rate_limit" as const,
      scope: "account" as const,
      window: "minute" as const,
      used: null,
      limit: null,
      remaining: null,
      resetsAt: null,
      expiresAt: null,
      observedAt: caps[0]!.observedAt,
      source: "official_api" as const,
      exact: true,
    }];
    void lo; void hi;
  }

  // Group by platform + account. Within a group, limits sort running-out first.
  const groups = new Map<string, Group>();
  for (const o of observations) {
    const key = groupKey(o);
    if (!groups.has(key)) {
      const account = accountOf(o);
      groups.set(key, {
        provider: o.provider,
        account,
        title: groupTitle(o.provider, account),
        rows: [],
      });
    }
    groups.get(key)!.rows.push({ obs: o, name: limitName(o), attention: urgency(o) < 2 });
  }
  const sortedGroups = [...groups.values()].map((g) => ({
    ...g,
    rows: [...g.rows].sort((a, b) => urgency(a.obs) - urgency(b.obs)),
  }));
  // Groups holding an attention row surface first; then alphabetical.
  sortedGroups.sort(
    (a, b) =>
      (b.rows.some((r) => r.attention) ? 1 : 0) - (a.rows.some((r) => r.attention) ? 1 : 0)
      || a.title.localeCompare(b.title),
  );

  const { limitPad } = layoutWidths(sortedGroups);

  for (const g of sortedGroups) {
    lines.push(g.title);
    for (const { obs, name } of g.rows) lines.push(rowFor(obs, name, limitPad, capSummary));
    lines.push("");
  }

  // Adapter failures close the view — after the data, where they read as footnotes.
  const unhealthy = snap.adapters.filter((a) => a.status !== "ok");
  if (unhealthy.length) {
    lines.push("unavailable");
    for (const a of unhealthy) {
      lines.push(`  ${PROVIDER_TITLE[a.provider] ?? a.provider} — ${a.detail ?? a.status}`);
    }
    lines.push("");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** One aligned row inside a group: limit name, bar, percent, countdown. */
function rowFor(o: UsageObservation, name: string, limitPad: number, capSummary: string | null): string {
  const indent = "  ";
  const label = `${name.padEnd(limitPad)} `;
  switch (o.metric) {
    case "allowance": {
      if (o.used !== null && o.limit !== null && o.limit > 0) {
        const pct = Math.round(o.used);
        // Product rows are a breakdown of their parent's shared allowance — a second
        // full bar and duplicate reset countdown imply separate quotas. Show percentages only.
        const product = productOf(o.entitlement);
        if (product && ["build", "chat", "imagine", "api"].includes(product.toLowerCase())) {
          return `${indent}  ${label}${String(pct).padStart(3)}%`;
        }
        const barText = colorFor(pct, label + colorFor(pct, bar(pct)));
        const when = countdown(o.resetsAt) || shortReset(o.resetsAt ?? "");
        return `${indent}${barText} ${String(pct).padStart(3)}%  ${when}`;
      }
      return `${indent}${label}— unknown`;
    }
    case "reset_credit":
      return `${indent}${label}${o.remaining === 1 ? "available" : "consumed"}${o.expiresAt ? ` · expires ${shortReset(o.expiresAt)}` : ""}`;
    case "credit": {
      const epoch = o.resetsAt ? ` · epoch ${shortReset(o.resetsAt)}` : "";
      const amount = creditAmount(o.entitlement, o.remaining);
      return `${indent}${label}${amount === "$0" ? "none" : `${amount} remaining`}${epoch}`;
    }
    case "rate_limit":
      return `${indent}${label}${capSummary ?? `${o.limit ?? "?"} req/min cap`}`;
    default:
      return `${indent}${label}${o.entitlement}`;
  }
}
