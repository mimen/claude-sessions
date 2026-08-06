import { buildBridge, type Bridge } from "../cmux/bridge.ts";

export interface SnapshotLivenessReader {
  /** Serve the last completed read, starting one refresh when it is stale. */
  read(): Promise<Bridge>;
  /** Start a refresh now, or queue one trailing refresh behind the current flight. */
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
 * immediately while one stale refresh runs in the background. A refresh retries one unreadable or
 * rejected read immediately, then replaces the cache with an unreadable Bridge only if both attempts
 * fail. Actions do not use this reader and continue to call the live seam directly.
 */
export function createSnapshotLivenessReader(
  options: SnapshotLivenessReaderOptions,
): SnapshotLivenessReader {
  const now = options.now ?? (() => Date.now());
  let cached: Bridge | null = null;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  let forcedTrailingRefresh = false;

  async function readBridgeWithRetry(): Promise<Bridge> {
    try {
      const bridge = await options.readBridge();
      if (bridge.readable) return bridge;
    } catch {
      // Rejections and unreadable Bridges are the same liveness failure and get one immediate retry.
    }

    try {
      const bridge = await options.readBridge();
      return bridge.readable ? bridge : unreadableBridge();
    } catch {
      return unreadableBridge();
    }
  }

  function startRefresh(): Promise<void> {
    if (inFlight !== null) return inFlight;

    let flight: Promise<void>;
    flight = Promise.resolve()
      .then(readBridgeWithRetry)
      .then((bridge) => {
        cached = bridge;
        refreshedAt = now();
      })
      .catch(() => {
        cached = unreadableBridge();
        refreshedAt = now();
      })
      .finally(() => {
        if (inFlight !== flight) return;
        inFlight = null;
        if (forcedTrailingRefresh) {
          forcedTrailingRefresh = false;
          void startRefresh();
        }
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
      if (inFlight !== null) {
        // A visibility or post-action hint must observe state newer than the current flight. Several
        // hints during that flight still need only one trailing read.
        forcedTrailingRefresh = true;
        return;
      }
      void startRefresh();
    },
  };
}
