/** Display helpers for the TUI: model badges and compact money formatting. */

/** A model family, derived from a model id, with a short label and a stable color. */
export interface ModelBadge {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

// Order matters: first prefix match wins. Muted family hues — legible but not shouting, since
// a model tag sits on most rows and color-only would be noise (it's always paired with the label).
const FAMILIES: ReadonlyArray<readonly [prefix: string, label: string, color: string]> = [
  ["claude-fable", "fable", "#a689c9"],
  ["claude-mythos", "mythos", "#a689c9"],
  ["claude-opus", "opus", "#c99a6b"],
  ["claude-sonnet", "sonnet", "#6f9bc2"],
  ["claude-haiku", "haiku", "#7ba85f"],
  ["claude-3-opus", "opus", "#c99a6b"],
  ["claude-3-5-sonnet", "sonnet", "#6f9bc2"],
  ["claude-3-7-sonnet", "sonnet", "#6f9bc2"],
  ["claude-3-5-haiku", "haiku", "#7ba85f"],
  ["claude-3-haiku", "haiku", "#7ba85f"],
];

function familyOf(modelId: string): ModelBadge {
  for (const [prefix, label, color] of FAMILIES) {
    if (modelId.startsWith(prefix)) return { key: label, label, color };
  }
  return { key: "other", label: "·", color: "#6b7280" };
}

/**
 * The dominant model badge for a Session — the family that accounts for the most spend.
 * Returns null when no model cost was recorded (e.g. subagent stubs, unpriced sessions).
 */
export function dominantModel(costByModel: Readonly<Record<string, number>>): ModelBadge | null {
  let best: string | null = null;
  let bestCost = -1;
  for (const [model, cost] of Object.entries(costByModel)) {
    if (cost > bestCost) {
      bestCost = cost;
      best = model;
    }
  }
  return best ? familyOf(best) : null;
}

/** All model families used by a Session, richest first (for the preview breakdown). */
export function modelBreakdown(
  costByModel: Readonly<Record<string, number>>,
): Array<{ badge: ModelBadge; usd: number }> {
  const byFamily = new Map<string, { badge: ModelBadge; usd: number }>();
  for (const [model, cost] of Object.entries(costByModel)) {
    const badge = familyOf(model);
    const prev = byFamily.get(badge.key);
    if (prev) prev.usd += cost;
    else byFamily.set(badge.key, { badge, usd: cost });
  }
  return [...byFamily.values()].sort((a, b) => b.usd - a.usd);
}

/**
 * Calm cost for the list column: whole dollars so the column stays decimal-clean and scannable
 * ("$74", "$418"); cents only under a dollar; blank for zero. Precise cents live in the preview.
 */
export function formatCostList(usd: number): string {
  if (usd <= 0) return "";
  if (usd < 1) return `${Math.max(1, Math.round(usd * 100))}¢`;
  return `$${Math.round(usd)}`;
}

/** Compact USD for headers/aggregates: "$0" · "$412" · "$2.9k" · "$13.1k". */
export function formatCompactUSD(usd: number): string {
  if (usd < 1000) return `$${Math.round(usd)}`;
  if (usd < 1_000_000) return `$${(usd / 1000).toFixed(usd < 10_000 ? 1 : 0)}k`;
  return `$${(usd / 1_000_000).toFixed(1)}m`;
}

/** Human cadence from seconds: "45s" · "12m" · "1.5h" · "3.2h" · "2.1d". Blank for 0. */
export function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "";
  if (sec < 90) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 90) return `${Math.round(min)}m`;
  const hr = min / 60;
  if (hr < 48) return `${hr < 10 ? hr.toFixed(1) : Math.round(hr)}h`;
  return `${(hr / 24).toFixed(1)}d`;
}

/** API-equivalent burn rate in USD/day from a session's cost + active span. Null if unknowable. */
export function burnPerDay(costUSD: number, firstTs: string | null, lastTs: string | null): number | null {
  if (costUSD <= 0 || !firstTs || !lastTs) return null;
  const spanMs = Date.parse(lastTs) - Date.parse(firstTs);
  if (!(spanMs > 0)) return null;
  const days = spanMs / 86_400_000;
  if (days < 1 / 24) return null; // under an hour of span — rate is noise
  return costUSD / days;
}

/** Compact token count: "0" · "812" · "3.4k" · "1.2m" · "4.1b". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}m`;
  return `${(n / 1_000_000_000).toFixed(1)}b`;
}
