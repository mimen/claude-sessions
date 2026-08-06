/**
 * Per-directory facts that are expensive to read but almost never change.
 *
 * Resolving a worktree costs two `git` calls and finding an icon costs a handful of `stat`s.
 * Doing that for every directory on every poll dominates the snapshot, so results are cached
 * for a short while. A directory's checkout identity and icon do not move on a four-second
 * cadence; cmux status, which does, is never cached.
 */
import { findFavicon } from "./favicon.ts";
import { resolveCheckout } from "./worktree.ts";
import type { CheckoutInput } from "./projection.ts";

/** Long enough to take most polls off the filesystem, short enough to notice a new checkout. */
const TTL_MS = 60_000;
const LOOKUP_CONCURRENCY = 6;

interface DirectoryFacts {
  readonly checkout: CheckoutInput | null;
  readonly favicon: string | null;
}

export interface DirectoryFactsResult {
  readonly checkouts: Map<string, CheckoutInput>;
  readonly favicons: Map<string, string>;
}

interface CacheEntry extends DirectoryFacts {
  readonly readAt: number;
}

/** A cache scoped to one caller, so tests and separate hosts never share state. */
export function createDirectoryFactsCache(now: () => number = () => Date.now()) {
  const cache = new Map<string, CacheEntry>();

  async function read(directory: string): Promise<DirectoryFacts> {
    const [checkout, favicon] = await Promise.all([
      resolveCheckout(directory),
      Promise.resolve(findFavicon(directory)),
    ]);
    return { checkout, favicon };
  }

  return {
    /** Facts for each directory, reading only the ones whose cached entry has expired. */
    async lookup(directories: readonly string[]): Promise<DirectoryFactsResult> {
      const wanted = [...new Set(directories)];
      const current = now();
      const stale = wanted.filter((directory) => {
        const entry = cache.get(directory);
        return !entry || current - entry.readAt >= TTL_MS;
      });

      let cursor = 0;
      async function worker(): Promise<void> {
        while (cursor < stale.length) {
          const directory = stale[cursor];
          cursor += 1;
          if (!directory) continue;
          cache.set(directory, { ...(await read(directory)), readAt: now() });
        }
      }
      await Promise.all(Array.from(
        { length: Math.min(LOOKUP_CONCURRENCY, stale.length) },
        () => worker(),
      ));

      // Entries for directories that no longer appear are dropped, so a closed session's icon
      // stops being servable rather than lingering behind the favicon endpoint.
      const live = new Set(wanted);
      for (const directory of [...cache.keys()]) {
        if (!live.has(directory)) cache.delete(directory);
      }

      const checkouts = new Map<string, CheckoutInput>();
      const favicons = new Map<string, string>();
      for (const directory of wanted) {
        const entry = cache.get(directory);
        if (!entry) continue;
        if (entry.checkout) checkouts.set(directory, entry.checkout);
        if (entry.favicon) favicons.set(directory, entry.favicon);
      }
      return { checkouts, favicons };
    },
  };
}
