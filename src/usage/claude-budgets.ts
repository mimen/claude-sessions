import type { UsageObservation } from "./types.ts";

export type AllocationUsage =
  | { kind: "known"; usedPct: number; resetsAt: string | null; cached: boolean }
  | { kind: "unknown"; reason: string };

export interface ClaudeBudget {
  name: "Fable budget" | "Opus budget";
  usage: AllocationUsage;
}

function percentage(row: UsageObservation | undefined): number | null {
  if (!row || row.used === null || row.limit === null || row.limit <= 0) return null;
  const pct = row.used / row.limit * 100;
  return Number.isFinite(pct) && pct >= 0 ? pct : null;
}

function cached(row: UsageObservation): boolean {
  return "stale" in row && row.stale === true;
}

function sameReset(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return Math.floor(Date.parse(left) / 1_000) === Math.floor(Date.parse(right) / 1_000);
}

export function claudeBudgets(rows: UsageObservation[]): ClaudeBudget[] {
  const weeklyRows = rows.filter(row => row.metric === "allowance" && row.window === "weekly" && !row.entitlement.includes("#"));
  const fableRows = rows.filter(row => row.metric === "allowance" && row.window === "weekly" && row.entitlement.toLowerCase().endsWith("#fable"));
  if (weeklyRows.length > 1 || fableRows.length > 1) return [];
  const weekly = weeklyRows[0];
  const fable = fableRows[0];
  if (!weekly && !fable) return [];
  if (weekly && fable && fable.entitlement.slice(0, fable.entitlement.indexOf("#")) !== weekly.entitlement) return [];

  const weeklyPct = percentage(weekly);
  const fablePct = percentage(fable);
  const fableUsage: AllocationUsage = fable && fablePct !== null
    ? { kind: "known", usedPct: fablePct, resetsAt: fable.resetsAt, cached: cached(fable) }
    : { kind: "unknown", reason: "Fable reading unavailable" };
  let opusUsage: AllocationUsage;
  if (!fable || fablePct === null) {
    opusUsage = { kind: "unknown", reason: "Fable reading unavailable" };
  } else if (!weekly || weeklyPct === null) {
    opusUsage = { kind: "unknown", reason: "weekly reading unavailable" };
  } else if (cached(weekly) || cached(fable)) {
    opusUsage = { kind: "unknown", reason: "cached readings" };
  } else if (Date.parse(weekly.observedAt) !== Date.parse(fable.observedAt)) {
    opusUsage = { kind: "unknown", reason: "observation times differ" };
  } else if (!sameReset(weekly.resetsAt, fable.resetsAt) && !(fablePct === 0 && fable.resetsAt === null)) {
    opusUsage = { kind: "unknown", reason: "reset windows differ" };
  } else {
    // This is the user's 50/50 allocation model, not a provider-reported non-Fable quota.
    const opusPct = 2 * weeklyPct - fablePct;
    opusUsage = opusPct < 0
      ? { kind: "unknown", reason: "inconsistent 50/50 readings" }
      : { kind: "known", usedPct: opusPct, resetsAt: weekly.resetsAt, cached: false };
  }
  return [{ name: "Fable budget", usage: fableUsage }, { name: "Opus budget", usage: opusUsage }];
}
