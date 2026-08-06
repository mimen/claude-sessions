import { buildBridge, type Bridge } from "../cmux/bridge.ts";

export interface SnapshotLivenessReader {
  /** Serve the last completed read, starting one refresh when it is stale. */
  read(): Promise<Bridge>;
  /** Start one refresh now without making the caller wait for it. */
  refresh(): void;
}

export interface SnapshotLivenessReaderOptions {
  readonly ttlMs: number;
  readonly readBridge: () => Promise<Bridge>;
  readonly now?: () => number;
}

function unreadableBridge(): Bridge {
  return buildBridge({ windows: [] }, {}, false);
}

/**
 * Keep the snapshot's cmux tree warm without weakening action safety.
 *
 * The first snapshot waits for a truthful read. Later snapshots serve the last completed Bridge
 * immediately while one stale refresh runs in the background. A failed read replaces the cache
 * with an unreadable Bridge, so stale-while-revalidate never turns a liveness failure into a
 * readable empty fleet. Actions do not use this reader and continue to call the live seam directly.
 */
export function createSnapshotLivenessReader(
  options: SnapshotLivenessReaderOptions,
): SnapshotLivenessReader {
  const now = options.now ?? (() => Date.now());
  let cached: Bridge | null = null;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  function startRefresh(): Promise<void> {
    if (inFlight !== null) return inFlight;

    let flight: Promise<void>;
    flight = Promise.resolve()
      .then(options.readBridge)
      .then((bridge) => {
        cached = bridge;
        refreshedAt = now();
      })
      .catch(() => {
        cached = unreadableBridge();
        refreshedAt = now();
      })
      .finally(() => {
        if (inFlight === flight) inFlight = null;
      });
    inFlight = flight;
    return flight;
  }

  return {
    async read(): Promise<Bridge> {
      if (cached === null) await startRefresh();
      else if (now() - refreshedAt >= options.ttlMs) void startRefresh();
      return cached ?? unreadableBridge();
    },
    refresh(): void {
      void startRefresh();
    },
  };
}
