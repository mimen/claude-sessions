import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimeRoot } from "../paths.ts";

/**
 * Whether the enrichment sweep is actually running.
 *
 * This exists because the feature has now failed the same way twice, and both times the failure
 * was invisible. The first: the launchd plist pointed at a deployment that predated the `enrich`
 * command, so every run died on `Unknown command`. The second: the plist pointed at a pinned
 * worktree supporting index schema v11 while the live cache moved to v12, and the sweep
 * crash-looped every fifteen minutes for five hours — 42 logged failures — while the store quietly
 * went stale and `ccs ls` showed titles from an older world.
 *
 * Both were discovered by accident. A pipeline whose entire job is keeping the store legible must
 * not be able to die quietly, so its liveness becomes a fact the reading surfaces can print.
 *
 * A plain JSON file rather than a catalogue column: this is observational state about the RUNNER,
 * not about any session, and giving it a row would mean inventing a session to hang it on.
 */

export interface SweepHealth {
  /** ISO timestamp of the last sweep that completed without aborting. Null if never. */
  readonly lastSuccessAt: string | null;
  /** Sessions enriched in that run. */
  readonly lastSuccessEnriched: number;
  /** Consecutive runs that have failed or aborted since. Reset by any success. */
  readonly consecutiveFailures: number;
  /** Why the most recent failure happened, truncated. Null when the last run succeeded. */
  readonly lastFailure: string | null;
  readonly lastFailureAt: string | null;
}

const EMPTY: SweepHealth = {
  lastSuccessAt: null,
  lastSuccessEnriched: 0,
  consecutiveFailures: 0,
  lastFailure: null,
  lastFailureAt: null,
};

export function healthPath(): string {
  return join(runtimeRoot(), "cache", "enrich-health.json");
}

export function readSweepHealth(path = healthPath()): SweepHealth {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SweepHealth>;
    return {
      lastSuccessAt: parsed.lastSuccessAt ?? null,
      lastSuccessEnriched: parsed.lastSuccessEnriched ?? 0,
      consecutiveFailures: parsed.consecutiveFailures ?? 0,
      lastFailure: parsed.lastFailure ?? null,
      lastFailureAt: parsed.lastFailureAt ?? null,
    };
  } catch {
    // Missing or corrupt reads as "never ran", which is the honest answer and the one that makes
    // the surfaces say something rather than throw on a fresh machine.
    return EMPTY;
  }
}

function write(health: SweepHealth, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(health, null, 2)}\n`, "utf8");
  } catch {
    // Health tracking must never be the reason a sweep fails. A lost write costs one data point;
    // a thrown error costs the run that was about to enrich forty sessions.
  }
}

export function recordSweepSuccess(enriched: number, now: string, path = healthPath()): void {
  write({
    lastSuccessAt: now,
    lastSuccessEnriched: enriched,
    consecutiveFailures: 0,
    lastFailure: null,
    lastFailureAt: null,
  }, path);
}

export function recordSweepFailure(reason: string, now: string, path = healthPath()): void {
  const current = readSweepHealth(path);
  write({
    ...current,
    consecutiveFailures: current.consecutiveFailures + 1,
    lastFailure: reason.slice(0, 300),
    lastFailureAt: now,
  }, path);
}

/** Hours since the last successful sweep, or null when it has never succeeded. */
export function hoursSinceSuccess(health: SweepHealth, now: Date = new Date()): number | null {
  if (!health.lastSuccessAt) return null;
  const then = Date.parse(health.lastSuccessAt);
  if (Number.isNaN(then)) return null;
  return (now.getTime() - then) / 3_600_000;
}

/**
 * The warning a reading surface prints, or null when the sweep is healthy.
 *
 * Six hours is not arbitrary: it matches the age backstop in the freshness rule, so the sweep is
 * called unhealthy exactly when it has been down long enough for that rule to have wanted to fire.
 */
export function sweepWarning(health: SweepHealth, now: Date = new Date()): string | null {
  const hours = hoursSinceSuccess(health, now);
  if (hours === null) {
    return health.consecutiveFailures > 0
      ? `enrichment sweep has never succeeded · ${health.consecutiveFailures} failed runs` +
        (health.lastFailure ? ` · ${health.lastFailure}` : "")
      : null;
  }
  if (hours < 6 && health.consecutiveFailures === 0) return null;
  const age = hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
  const failures = health.consecutiveFailures > 0
    ? ` · ${health.consecutiveFailures} failed run${health.consecutiveFailures === 1 ? "" : "s"}`
    : "";
  const why = health.lastFailure ? ` · ${health.lastFailure}` : "";
  return `enrichment sweep last succeeded ${age} ago${failures}${why}`;
}
