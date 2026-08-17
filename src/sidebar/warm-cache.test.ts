import { describe, expect, test } from "bun:test";
import { createWarmCache, type WarmCacheColdRead } from "./warm-cache.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (error: Error) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function settleRefresh(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createWarmCache", () => {
  for (const row of [
    { coldRead: "block" as const, coldValue: "loaded", settlesCold: false },
    { coldRead: "serve-initial" as const, coldValue: "initial", settlesCold: true },
  ] satisfies ReadonlyArray<{
    readonly coldRead: WarmCacheColdRead;
    readonly coldValue: string;
    readonly settlesCold: boolean;
  }>) {
    test(`${row.coldRead}: cold, warm, expired, and single-flight behavior`, async () => {
      let clock = 100;
      let calls = 0;
      const coldLoad = deferred<string>();
      const expiredLoad = deferred<string>();
      const cache = createWarmCache<void, string>({
        ttlMs: 10,
        initialValue: "initial",
        coldRead: row.coldRead,
        now: () => clock,
        load: () => {
          calls += 1;
          return calls === 1 ? coldLoad.promise : expiredLoad.promise;
        },
        failure: { type: "retain-and-retry" },
      });

      let coldSettled = false;
      const cold = cache.read().then((value) => {
        coldSettled = true;
        return value;
      });
      const concurrentCold = cache.read();
      await Promise.resolve();
      expect(calls).toBe(1);
      expect(coldSettled).toBe(row.settlesCold);
      if (row.coldRead === "serve-initial") {
        await expect(cold).resolves.toBe(row.coldValue);
        await expect(concurrentCold).resolves.toBe(row.coldValue);
      }

      clock = 500;
      coldLoad.resolve("loaded");
      await coldLoad.promise;
      await settleRefresh();
      if (row.coldRead === "block") {
        await expect(cold).resolves.toBe(row.coldValue);
        await expect(concurrentCold).resolves.toBe(row.coldValue);
      }

      // Freshness starts when the loader completes, not when it starts.
      clock = 509;
      await expect(cache.read()).resolves.toBe("loaded");
      expect(calls).toBe(1);

      clock = 510;
      await expect(cache.read()).resolves.toBe("loaded");
      await expect(cache.read()).resolves.toBe("loaded");
      await settleRefresh();
      expect(calls).toBe(2);

      expiredLoad.resolve("refreshed");
      await expiredLoad.promise;
      await settleRefresh();
      await expect(cache.read()).resolves.toBe("refreshed");
      expect(calls).toBe(2);
    });
  }

  test("cleans up an identity-matched flight after a synchronous throw and retries", async () => {
    let calls = 0;
    const cache = createWarmCache<void, string>({
      ttlMs: 10,
      initialValue: "initial",
      coldRead: "block",
      now: () => 100,
      load: () => {
        calls += 1;
        if (calls === 1) throw new Error("synchronous loader failure");
        return Promise.resolve("recovered");
      },
      failure: { type: "retain-and-retry" },
    });

    await expect(cache.read()).rejects.toThrow("synchronous loader failure");
    await expect(cache.read()).resolves.toBe("recovered");
    expect(calls).toBe(2);
  });

  test("retains stale data after a background rejection and retries on the next read", async () => {
    let clock = 100;
    let calls = 0;
    const rejectedRefresh = deferred<string>();
    const successfulRetry = deferred<string>();
    const cache = createWarmCache<void, string>({
      ttlMs: 10,
      initialValue: "initial",
      coldRead: "block",
      now: () => clock,
      load: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve("warm");
        if (calls === 2) return rejectedRefresh.promise;
        return successfulRetry.promise;
      },
      failure: { type: "retain-and-retry" },
    });

    await expect(cache.read()).resolves.toBe("warm");
    clock = 110;
    await expect(cache.read()).resolves.toBe("warm");
    rejectedRefresh.reject(new Error("background failed"));
    await expect(rejectedRefresh.promise).rejects.toThrow("background failed");
    await settleRefresh();

    await expect(cache.read()).resolves.toBe("warm");
    await settleRefresh();
    expect(calls).toBe(3);

    successfulRetry.resolve("new value");
    await successfulRetry.promise;
    await settleRefresh();
    await expect(cache.read()).resolves.toBe("new value");
  });
});

describe("createWarmCache invalidation", () => {
  test("a change notification revalidates without waiting out the TTL", async () => {
    let clock = 100;
    let calls = 0;
    const cache = createWarmCache<void, string>({
      ttlMs: 10_000,
      initialValue: "initial",
      coldRead: "block",
      now: () => clock,
      load: () => {
        calls += 1;
        return Promise.resolve(`value ${calls}`);
      },
      failure: { type: "retain-and-retry" },
    });

    await expect(cache.read()).resolves.toBe("value 1");
    // Well inside a ten-second TTL: without invalidation this read would never reload.
    clock = 200;
    await expect(cache.read()).resolves.toBe("value 1");
    expect(calls).toBe(1);

    cache.invalidate();
    // The warm value is still served rather than the reader being made to wait.
    await expect(cache.read()).resolves.toBe("value 1");
    await settleRefresh();
    await expect(cache.read()).resolves.toBe("value 2");
  });

  test("invalidating before anything is cached leaves the cold read alone", async () => {
    let calls = 0;
    const cache = createWarmCache<void, string>({
      ttlMs: 10,
      initialValue: "initial",
      coldRead: "block",
      now: () => 100,
      load: () => {
        calls += 1;
        return Promise.resolve("loaded");
      },
      failure: { type: "retain-and-retry" },
    });

    cache.invalidate();
    await expect(cache.read()).resolves.toBe("loaded");
    expect(calls).toBe(1);
  });

  test("a refresh that began before the change does not clear the staleness it predates", async () => {
    // The failure this prevents: an event fires mid-flight, the in-flight read returns the state
    // the event replaced, and the cache then considers itself current on a value that is already
    // wrong -- which is the stale-row bug arriving by a new route.
    let clock = 100;
    let calls = 0;
    const firstFlight = deferred<string>();
    const cache = createWarmCache<void, string>({
      ttlMs: 10,
      initialValue: "initial",
      coldRead: "block",
      now: () => clock,
      load: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve("warm");
        if (calls === 2) return firstFlight.promise;
        return Promise.resolve("after the change");
      },
      failure: { type: "retain-and-retry" },
    });

    await expect(cache.read()).resolves.toBe("warm");
    clock = 120;
    // Starts flight two, which is now in progress and predates the change below.
    await expect(cache.read()).resolves.toBe("warm");
    expect(calls).toBe(2);

    cache.invalidate();
    firstFlight.resolve("state the change replaced");
    await firstFlight.promise;
    await settleRefresh();

    // Still stale, so this read starts a third load rather than trusting flight two.
    await expect(cache.read()).resolves.toBe("state the change replaced");
    await settleRefresh();
    expect(calls).toBe(3);
    await expect(cache.read()).resolves.toBe("after the change");
  });

  test("announces when an invalidation-provoked refresh lands, and not for TTL refreshes", async () => {
    let clock = 100;
    let calls = 0;
    let replaced = 0;
    const cache = createWarmCache<void, string>({
      ttlMs: 10,
      initialValue: "initial",
      coldRead: "block",
      now: () => clock,
      load: () => {
        calls += 1;
        return Promise.resolve(`value ${calls}`);
      },
      failure: { type: "retain-and-retry" },
      onReplaced: () => {
        replaced += 1;
      },
    });

    // Cold read and a TTL-expired refresh: routine reads, nothing to announce.
    await expect(cache.read()).resolves.toBe("value 1");
    clock = 120;
    await expect(cache.read()).resolves.toBe("value 1");
    await settleRefresh();
    await settleRefresh();
    expect(calls).toBe(2);
    expect(replaced).toBe(0);

    // An invalidation already told clients something changed; the announcement here is the
    // moment the refetch they make would actually see it.
    cache.invalidate();
    await expect(cache.read()).resolves.toBe("value 2");
    await settleRefresh();
    await settleRefresh();
    expect(calls).toBe(3);
    expect(replaced).toBe(1);
    await expect(cache.read()).resolves.toBe("value 3");
  });
});
