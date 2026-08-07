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
  readonly attemptTimeoutMs?: number;
}

const SNAPSHOT_LIVENESS_ATTEMPT_TIMEOUT_MS = 1_500;

function unreadableBridge(): Bridge {
  return buildBridge({ windows: [] }, {}, false);
}

/**
 * Keep the snapshot's cmux tree warm without weakening action safety.
 *
 * The first snapshot waits for a truthful read. Later snapshots serve the last completed Bridge
 * immediately while one stale refresh runs in the background. A refresh retries one unreadable,
 * rejected, or timed-out read immediately, then replaces the cache with an unreadable Bridge only if
 * both bounded attempts fail. Actions do not use this reader and continue to call the live seam directly.
 */
export function createSnapshotLivenessReader(
  options: SnapshotLivenessReaderOptions,
): SnapshotLivenessReader {
  const now = options.now ?? (() => Date.now());
  const attemptTimeoutMs = options.attemptTimeoutMs ?? SNAPSHOT_LIVENESS_ATTEMPT_TIMEOUT_MS;
  let cached: Bridge | null = null;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  let forcedTrailingRefresh = false;

  async function readBridgeAttempt(): Promise<Bridge | null> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), attemptTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve()
          .then(options.readBridge)
          .then((bridge) => bridge.readable ? bridge : null)
          .catch(() => null),
        timeout,
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function readBridgeWithRetry(): Promise<Bridge> {
    const first = await readBridgeAttempt();
    if (first !== null) return first;

    return (await readBridgeAttempt()) ?? unreadableBridge();
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
