import { humanizeSlug, workRefOfIdentityKey } from "../catalogue/identity-key.ts";
import { colorOf, displayModelRegistry, shortOf } from "../models/registry.ts";

/** Display helpers for the TUI: model badges and compact money formatting. */

/** A model family, derived from a model id, with a short label and a stable color. */
export interface ModelBadge {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

/**
 * A model's badge, resolved from the shared registry: its short name lowercased, and the colour
 * the registry gives it. Muted family hues, legible but not shouting, since a model tag sits on
 * most rows and colour-only would be noise (it is always paired with the label).
 *
 * `other` is the honest answer for an id no registry row claims, and it is what a session renders
 * as while the registry is unreadable.
 */
export function familyOf(modelId: string): ModelBadge {
  const registry = displayModelRegistry();
  const short = registry ? shortOf(registry, modelId) : null;
  const color = registry ? colorOf(registry, modelId) : null;
  if (!short) return { key: "other", label: "·", color: color ?? "#6b7280" };
  const label = short.toLowerCase();
  return { key: label, label, color: color ?? "#6b7280" };
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

/**
 * List-column model badge: dominant-by-spend when any cost was recorded, else the first model
 * from the persisted model set — so an all-zero-cost session (pure-gpt: unpriced) still badges.
 */
export function modelBadge(
  costByModel: Readonly<Record<string, number>>,
  models: readonly string[],
): ModelBadge | null {
  const dominant = dominantModel(costByModel);
  if (dominant) return dominant;
  const first = models[0];
  return first ? familyOf(first) : null;
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

/**
 * Compact Event Watch identity annotation for a session row. Core identities already read as
 * their role in the hierarchy, while fleet worker refs become a scannable event label. Other
 * clusters retain their full key because CCS has no cluster-specific display contract for them.
 */
export function identityRowLabel(identityKey: string | null | undefined): string | null {
  if (!identityKey) return null;
  if (identityKey.startsWith("event-watch:") && identityKey.split(":").length === 2) return null;

  if (!identityKey.startsWith("event-watch:event-worker:")) return identityKey;

  const workRef = workRefOfIdentityKey(identityKey);
  return workRef ? humanizeSlug(workRef) : identityKey;
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
