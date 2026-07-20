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
  /** True when titling was skipped because the titler tool isn't available. */
  skippedUnavailable?: boolean;
}

export interface BackfillOptions {
  concurrency: number;
  maxAttempts: number;
  /** Called after each Session resolves, for live progress. */
  onProgress?: (done: number, total: number) => void;
  /** When this returns true, stop persisting/scheduling work (e.g. the TUI is exiting and
   *  about to close the DB). Prevents writes to a torn-down database. */
  isCancelled?: () => boolean;
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
  // If the titler tool isn't installed, skip entirely — don't burn an attempt on every
  // Session (which would permanently mark them failed once the cap is hit).
  if (!titler.available()) return { generated: 0, failed: 0, skippedUnavailable: true };
  // available() may synchronously probe PATH. An App can unmount while that starts, so check
  // cancellation again before touching the database.
  if (opts.isCancelled?.()) return { generated: 0, failed: 0 };

  const candidates = titleCandidates(db, opts.maxAttempts);
  const stats: BackfillStats = { generated: 0, failed: 0 };
  const total = candidates.length;
  let done = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < candidates.length) {
      if (opts.isCancelled?.()) return;
      const candidate: TitleCandidate = candidates[next++]!;
      const title = await titler.generate(candidate.skeleton);
      // The generate() call can take seconds; re-check before any DB write in case the app
      // exited and closed the database while we were waiting.
      if (opts.isCancelled?.()) return;
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
