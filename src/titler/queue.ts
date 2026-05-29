import type { Database } from "bun:sqlite";
import type { Titler } from "./codex.ts";
import {
  titleCandidates,
  saveCodexTitle,
  recordTitleFailure,
  type TitleCandidate,
} from "../index/index.ts";

export interface BackfillStats {
  generated: number;
  failed: number;
}

export interface BackfillOptions {
  concurrency: number;
  maxAttempts: number;
  /** Called after each Session resolves, for live progress. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Generate Codex Titles for every Session that needs one, running up to `concurrency`
 * Titler calls at once. Failures increment the attempt counter (capped) and never stop the
 * drain — a single bad Session keeps its fallback label and is skipped on later runs.
 */
export async function backfillTitles(
  db: Database,
  titler: Titler,
  opts: BackfillOptions,
): Promise<BackfillStats> {
  const candidates = titleCandidates(db, opts.maxAttempts);
  const stats: BackfillStats = { generated: 0, failed: 0 };
  const total = candidates.length;
  let done = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < candidates.length) {
      const candidate: TitleCandidate = candidates[next++]!;
      const title = await titler.generate(candidate.skeleton);
      if (title) {
        saveCodexTitle(db, candidate.sessionId, title);
        stats.generated++;
      } else {
        recordTitleFailure(db, candidate.sessionId);
        stats.failed++;
      }
      done++;
      opts.onProgress?.(done, total);
    }
  }

  const pool = Math.min(opts.concurrency, candidates.length);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return stats;
}
