/**
 * Last good usage per account, on disk, so a rate-limited or failed read keeps showing the
 * previous numbers (marked stale) instead of blanking, and so one Mac re-hits an account's
 * usage endpoint at most every MIN_INTERVAL_MS, or later when the upstream sent Retry-After.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeRoot } from "../paths.ts";
import type { UsageObservation } from "./types.ts";

export const MIN_INTERVAL_MS = 2 * 60_000;

/** A failed upstream read, with the upstream's raw Retry-After header when it sent one. */
export class UpstreamError extends Error {
  constructor(message: string, readonly retryAfter: string | null = null) {
    super(message);
  }
}

interface Entry {
  observations: UsageObservation[];
  /** Last attempt, good or not: the throttle clock. */
  attemptedAt: string;
  retryAt: string | null;
  lastError: string | null;
}

export interface CachedRead {
  observations: UsageObservation[];
  /** Why these numbers are not a fresh read, or null when they are. */
  issue: string | null;
}

export async function readThroughCache(
  key: string,
  fetch: () => Promise<UsageObservation[]>,
  opts: { dir?: string; now?: () => number } = {},
): Promise<CachedRead> {
  const dir = opts.dir ?? join(runtimeRoot(), "cache", "usage");
  const now = (opts.now ?? Date.now)();
  const path = join(dir, `${key.replace(/[^A-Za-z0-9@._-]/g, "_")}.json`);
  const entry = load(path);

  const waitUntil = entry ? Math.max(Date.parse(entry.attemptedAt) + MIN_INTERVAL_MS, Date.parse(entry.retryAt ?? "") || 0) : 0;
  if (entry && now < waitUntil) {
    return entry.lastError
      ? { observations: stale(entry.observations), issue: holdIssue(entry, now) }
      : { observations: entry.observations, issue: null };
  }

  try {
    const observations = await fetch();
    save(dir, path, { observations, attemptedAt: new Date(now).toISOString(), retryAt: null, lastError: null });
    return { observations, issue: null };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const retryAt = e instanceof UpstreamError ? retryAtFrom(e.retryAfter, now) : null;
    const kept = entry?.observations ?? [];
    save(dir, path, { observations: kept, attemptedAt: new Date(now).toISOString(), retryAt, lastError: message });
    return { observations: stale(kept), issue: message };
  }
}

function holdIssue(entry: Entry, now: number): string {
  const retry = Date.parse(entry.retryAt ?? "");
  return retry > now ? `${entry.lastError}, retry after ${entry.retryAt}` : entry.lastError!;
}

function stale(observations: UsageObservation[]): UsageObservation[] {
  return observations.map((o) => ({ ...o, stale: true }));
}

function load(path: string): Entry | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Entry;
  } catch {
    return null;
  }
}

/** Atomic, so the menu bar and a terminal `ccs usage` running together never read half a file. */
function save(dir: string, path: string, entry: Entry): void {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, path);
  } catch {
    // A read-only cache dir costs the throttle, not the reading.
  }
}

/** Retry-After as delta-seconds or an HTTP date, resolved against `now`. */
function retryAtFrom(value: string | null, now: number): string | null {
  if (!value) return null;
  const seconds = Number(value);
  const at = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}
