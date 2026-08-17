import { buildBridge, type Bridge } from "../cmux/bridge.ts";

export interface SnapshotLivenessReader {
  /** Serve the last completed read, starting one refresh when it is stale. */
  read(): Promise<Bridge>;
  /** Start a refresh now, or queue one trailing refresh behind the current flight. */
  refresh(): void;
  /**
   * Await a read newer than this call, rather than starting one and returning.
   *
   * `refresh` exists so a hint never delays the response that carried it. A caller that has just
   * changed the world needs the opposite: rebuilding from the cached bridge would project the
   * state the action replaced, which is why acting once looked like nothing happened and acting
   * twice looked instant.
   */
  refreshNow(): Promise<Bridge>;
  /**
   * Declare the cached tree out of date, leaving the read that needs it to pay for the reread.
   *
   * Deliberately not `refresh`: a read of the cmux tree is a subprocess, and this is called from a
   * stream of change notifications rather than once per request. Starting a refresh per
   * notification spawns processes at the rate cmux emits events, which starves the loop it was
   * meant to keep responsive. Marking stale costs nothing until somebody actually asks.
   */
  invalidate(): void;
}

export interface SnapshotLivenessReaderOptions {
  readonly ttlMs: number;
  readonly readBridge: () => Promise<Bridge>;
  readonly now?: () => number;
  readonly attemptTimeoutMs?: number;
  /** How long failed refreshes may keep serving the last readable Bridge before failing closed. */
  readonly maxStaleMs?: number;
}

const SNAPSHOT_LIVENESS_ATTEMPT_TIMEOUT_MS = 1_500;
const SNAPSHOT_LIVENESS_MAX_STALE_MS = 15_000;

function unreadableBridge(): Bridge {
  return buildBridge({ windows: [] }, {}, false);
}

/**
 * Keep the snapshot's cmux tree warm without weakening action safety.
 *
 * The first snapshot waits for a truthful read. Later snapshots serve the last completed readable
 * Bridge immediately while one stale refresh runs in the background. A refresh retries one unreadable,
 * rejected, or timed-out read immediately. If both bounded attempts fail, a cold cache remains
 * fail-closed while a warm cache retains its last readable Bridge. Actions do not use this reader and
 * continue to call the live seam directly.
 */
export function createSnapshotLivenessReader(
  options: SnapshotLivenessReaderOptions,
): SnapshotLivenessReader {
  const now = options.now ?? (() => Date.now());
  const attemptTimeoutMs = options.attemptTimeoutMs ?? SNAPSHOT_LIVENESS_ATTEMPT_TIMEOUT_MS;
  const maxStaleMs = options.maxStaleMs ?? SNAPSHOT_LIVENESS_MAX_STALE_MS;
  let cached: Bridge | null = null;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let lastReadableAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  let forcedTrailingRefresh = false;
  let stale = false;
  /** See the warm cache: a flight that began before the change must not clear the staleness. */
  let invalidations = 0;

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

  async function readBridgeWithRetry(): Promise<Bridge | null> {
    const first = await readBridgeAttempt();
    if (first !== null) return first;

    return readBridgeAttempt();
  }

  function completeRefresh(bridge: Bridge | null): void {
    if (bridge !== null) {
      cached = bridge;
      lastReadableAt = now();
    } else if (cached === null || !cached.readable) {
      cached = unreadableBridge();
    } else if (now() - lastReadableAt >= maxStaleMs) {
      // Serving the last readable Bridge bridges a transient cmux hiccup, but past this window the
      // frozen tree is a lie: rows keep a highlight that moved and the shelf keeps offering resumes
      // it cannot verify. Failing closed lets the projection tell the truth about not knowing.
      cached = unreadableBridge();
    }
    refreshedAt = now();
  }

  function startRefresh(): Promise<void> {
    if (inFlight !== null) return inFlight;

    const startedAt = invalidations;
    let flight: Promise<void>;
    flight = Promise.resolve()
      .then(readBridgeWithRetry)
      .then(completeRefresh)
      .catch(() => completeRefresh(null))
      .finally(() => {
        if (invalidations === startedAt) stale = false;
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
      // A tree known to be out of date is worth waiting for. The TTL path stays
      // stale-while-revalidate because expiry is only a guess that the tree moved; an invalidation
      // is cmux saying it did, and serving the previous one is the stale-row bug.
      else if (stale) await startRefresh();
      else if (now() - refreshedAt >= options.ttlMs) void startRefresh();
      return cached ?? unreadableBridge();
    },
    invalidate(): void {
      if (cached === null) return;
      invalidations += 1;
      stale = true;
    },
    async refreshNow(): Promise<Bridge> {
      // Join a flight already running, then take the trailing read it schedules: that flight may
      // have started before the change this caller made.
      if (inFlight !== null) await inFlight;
      await startRefresh();
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
