import type { ProviderId, SubscriptionInfo } from "./types.ts";

interface ConfiguredSubscription {
  provider: ProviderId;
  account: string | null;
  planName: string;
  monthlyDollars: number;
  anchor: string;
}

const REGISTRY: readonly ConfiguredSubscription[] = [
  { provider: "anthropic", account: "miladmaaan@gmail.com", planName: "Max 20x", monthlyDollars: 200, anchor: "2026-02-05" },
  { provider: "anthropic", account: "milad@afternoonumbrellafriends.com", planName: "Max 20x", monthlyDollars: 200, anchor: "2025-06-21" },
  { provider: "codex", account: "miladmaaan@gmail.com", planName: "Codex Pro", monthlyDollars: 200, anchor: "2026-08-21" },
  { provider: "grok", account: "miladmaaan@gmail.com", planName: "SuperGrok", monthlyDollars: 100, anchor: "2026-09-21" },
  { provider: "opencode-go", account: null, planName: "Go", monthlyDollars: 10, anchor: "2026-09-08" },
  { provider: "venice", account: null, planName: "Pro", monthlyDollars: 68, anchor: "2026-08-09" },
];

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function dateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function nextMonthlyRenewal(anchor: string, asOf: Date): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor);
  if (!match) throw new Error(`invalid subscription anchor: ${anchor}`);
  const anchorDate = new Date(`${anchor}T00:00:00Z`);
  if (Number.isNaN(anchorDate.getTime()) || dateOnly(anchorDate) !== anchor) {
    throw new Error(`invalid subscription anchor: ${anchor}`);
  }
  const today = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  if (today < anchorDate) return anchor;
  const anchorDay = Number(match[3]);
  let year = asOf.getUTCFullYear();
  let month = asOf.getUTCMonth();
  let day = Math.min(anchorDay, daysInUtcMonth(year, month));
  let candidate = new Date(Date.UTC(year, month, day));
  if (candidate < today) {
    month += 1;
    if (month === 12) {
      year += 1;
      month = 0;
    }
    day = Math.min(anchorDay, daysInUtcMonth(year, month));
    candidate = new Date(Date.UTC(year, month, day));
  }
  return dateOnly(candidate);
}

export function resolveSubscriptions(
  providers: readonly ProviderId[] | undefined,
  asOf: Date = new Date(),
): SubscriptionInfo[] {
  const wanted = providers ? new Set(providers) : null;
  return REGISTRY
    .filter((entry) => !wanted || wanted.has(entry.provider))
    .map(({ anchor, ...entry }) => ({
      ...entry,
      renewsOn: nextMonthlyRenewal(anchor, asOf),
      source: "configured" as const,
    }));
}
