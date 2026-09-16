import type { UsageObservation } from "./types.ts";

/** Which meter is the lower ceiling: the budget's own cap, or the weekly pool it nests inside. */
export type BudgetBinding = "own-cap" | "shared-pool";

export type AllocationUsage =
  | { kind: "known"; usedPct: number; resetsAt: string | null; cached: boolean; binding: BudgetBinding }
  | { kind: "unknown"; reason: string };

export interface ClaudeBudget {
  name: "Fable budget" | "Non-Fable budget";
  usage: AllocationUsage;
}

function percentage(row: UsageObservation | undefined): number | null {
  if (!row || row.used === null || row.limit === null || row.limit <= 0) return null;
  const pct = row.used * 100 / row.limit;
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

  // A non-Fable request spends only the shared weekly pool, so that one reading is the whole budget.
  const nonFableUsage: AllocationUsage = weekly && weeklyPct !== null
    ? { kind: "known", usedPct: weeklyPct, resetsAt: weekly.resetsAt, cached: cached(weekly), binding: "shared-pool" }
    : { kind: "unknown", reason: "weekly reading unavailable" };

  let fableUsage: AllocationUsage;
  if (!fable || fablePct === null) {
    fableUsage = { kind: "unknown", reason: "Fable reading unavailable" };
  } else if (!weekly || weeklyPct === null) {
    fableUsage = { kind: "unknown", reason: "weekly reading unavailable" };
  } else if (Date.parse(weekly.observedAt) !== Date.parse(fable.observedAt)) {
    fableUsage = { kind: "unknown", reason: "observation times differ" };
  } else if (!sameReset(weekly.resetsAt, fable.resetsAt) && !(fablePct === 0 && fable.resetsAt === null)) {
    fableUsage = { kind: "unknown", reason: "reset windows differ" };
  } else {
    // A Fable request spends the shared weekly pool too, so the fuller meter is the real ceiling.
    // Taking the larger of two real readings can only report a number one of them published.
    const ownCap = fablePct >= weeklyPct;
    fableUsage = {
      kind: "known",
      usedPct: ownCap ? fablePct : weeklyPct,
      resetsAt: ownCap ? fable.resetsAt : weekly.resetsAt,
      cached: cached(fable) || cached(weekly),
      binding: ownCap ? "own-cap" : "shared-pool",
    };
  }
  return [{ name: "Fable budget", usage: fableUsage }, { name: "Non-Fable budget", usage: nonFableUsage }];
}
