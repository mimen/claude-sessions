import type { ProviderId, SubscriptionInfo, SubscriptionRenewal } from "./types.ts";

interface ConfiguredSubscription {
  provider: ProviderId;
  account: string | null;
  planName: string;
  monthlyDollars: number;
  anchor: string | null;
}

const REGISTRY: readonly ConfiguredSubscription[] = [
  { provider: "anthropic", account: "miladmaaan@gmail.com", planName: "Max 20x", monthlyDollars: 200, anchor: "2026-09-10" },
  { provider: "anthropic", account: "milad@afternoonumbrellafriends.com", planName: "Max 20x", monthlyDollars: 200, anchor: "2026-09-08" },
  { provider: "codex", account: "miladmaaan@gmail.com", planName: "Codex Pro", monthlyDollars: 200, anchor: "2026-09-20" },
  { provider: "codex", account: "milad@theafternoonumbrellafriends.com", planName: "Codex Plus", monthlyDollars: 20, anchor: null },
  { provider: "grok", account: "miladmaaan@gmail.com", planName: "SuperGrok", monthlyDollars: 100, anchor: "2026-09-21" },
  { provider: "opencode-go", account: null, planName: "Go", monthlyDollars: 10, anchor: "2026-09-08" },
  { provider: "venice", account: null, planName: "Pro", monthlyDollars: 68, anchor: null },
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

function losAngelesDate(date: Date): { year: number; month: number; value: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = value("year");
  const month = value("month");
  const day = value("day");
  return {
    year,
    month,
    value: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export function nextMonthlyRenewal(anchor: string, asOf: Date): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor);
  if (!match) throw new Error(`invalid subscription anchor: ${anchor}`);
  const anchorDate = new Date(`${anchor}T00:00:00Z`);
  if (Number.isNaN(anchorDate.getTime()) || dateOnly(anchorDate) !== anchor) {
    throw new Error(`invalid subscription anchor: ${anchor}`);
  }
  const today = losAngelesDate(asOf);
  if (today.value < anchor) return anchor;
  const anchorDay = Number(match[3]);
  let year = today.year;
  let month = today.month - 1;
  let day = Math.min(anchorDay, daysInUtcMonth(year, month));
  let candidate = new Date(Date.UTC(year, month, day));
  if (dateOnly(candidate) < today.value) {
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
    .map(({ anchor, ...entry }) => anchor
      ? { ...entry, renewsOn: nextMonthlyRenewal(anchor, asOf), source: "configured" as const }
      : { ...entry, renewsOn: null, source: "unknown" as const });
}

export function renewalDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : losAngelesDate(parsed).value;
}

export function mergeSubscriptionRenewals(
  subscriptions: readonly SubscriptionInfo[],
  renewals: readonly SubscriptionRenewal[],
): SubscriptionInfo[] {
  const live = new Map(renewals.map((renewal) => [
    `${renewal.provider}:${renewal.account ?? ""}`,
    renewal,
  ]));
  return subscriptions.map((subscription) => {
    const renewal = live.get(`${subscription.provider}:${subscription.account ?? ""}`);
    return renewal ? { ...subscription, renewsOn: renewal.renewsOn, source: renewal.source } : subscription;
  });
}
