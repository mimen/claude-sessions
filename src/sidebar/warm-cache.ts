/** Generic single-value warm cache with stale-while-revalidate reads. */

export type WarmCacheColdRead = "block" | "serve-initial";

export type WarmCacheFailure<Input, Value> =
  | { readonly type: "retain-and-retry" }
  | { readonly type: "replace"; readonly value: (input: Input) => Value };

export interface WarmCacheOptions<Input, Value> {
  readonly ttlMs: number;
  readonly initialValue: Value;
  readonly coldRead: WarmCacheColdRead;
  readonly now?: () => number;
  readonly load: (input: Input) => Promise<Value>;
  readonly failure: WarmCacheFailure<Input, Value>;
}

export interface WarmCache<Input, Value> {
  read(input: Input): Promise<Value>;
  /**
   * Declare the cached value out of date, without discarding it.
   *
   * A TTL is a guess about when a value stopped being true. When something authoritative says it
   * did — a cmux event naming the workspace whose status just changed — the guess is no longer
   * needed and waiting out its remainder is pure latency.
   *
   * Deliberately not a reset to the cold state: cold reads may block, and a change notification
   * must never turn a warm cache into one that makes the next reader wait. The warm value stays
   * servable and one background refresh replaces it.
   */
  invalidate(): void;
}

type RefreshOutcome =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: Error };

/**
 * Create a cache whose first read may block or serve an initial value, then serves stale data while
 * one refresh runs in the background. Loader invocation is deferred to a promise turn so a
 * synchronous throw follows the same cleanup path as a rejected promise.
 */
export function createWarmCache<Input, Value>(
  options: WarmCacheOptions<Input, Value>,
): WarmCache<Input, Value> {
  const now = options.now ?? (() => Date.now());
  let cached = options.initialValue;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<RefreshOutcome> | null = null;
  let stale = false;
  /**
   * How many times the value has been declared out of date.
   *
   * A refresh already running when `invalidate` is called was started before the change and may
   * well return the state that change replaced, so its completion must not be allowed to clear
   * staleness. Comparing the count a flight began with against the count it ends with is what
   * distinguishes "this read saw the change" from "this read predates it".
   */
  let invalidations = 0;

  function refresh(input: Input): Promise<RefreshOutcome> {
    if (inFlight) return inFlight;

    const startedAt = invalidations;
    let flight: Promise<RefreshOutcome>;
    flight = Promise.resolve()
      .then(() => options.load(input))
      .then((value): RefreshOutcome => {
        cached = value;
        refreshedAt = now();
        return { status: "completed" };
      })
      .catch((error: Error): RefreshOutcome => {
        const failure = options.failure;
        if (failure.type === "replace") {
          cached = failure.value(input);
          refreshedAt = now();
          return { status: "completed" };
        }
        return { status: "failed", error };
      })
      .finally(() => {
        // A completed older flight must never clear a newer one if refresh scheduling changes later.
        if (inFlight === flight) inFlight = null;
        if (invalidations === startedAt) stale = false;
      });
    inFlight = flight;
    return flight;
  }

  return {
    async read(input: Input): Promise<Value> {
      if (refreshedAt === Number.NEGATIVE_INFINITY) {
        const refreshPromise = refresh(input);
        if (options.coldRead === "block") {
          const outcome = await refreshPromise;
          if (outcome.status === "failed") throw outcome.error;
        }
        return cached;
      }

      if (stale || now() - refreshedAt >= options.ttlMs) void refresh(input);
      return cached;
    },
    invalidate(): void {
      // Only meaningful once something has been cached; before that the cold path already reads.
      if (refreshedAt === Number.NEGATIVE_INFINITY) return;
      invalidations += 1;
      stale = true;
    },
  };
}
