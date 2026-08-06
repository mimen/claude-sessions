import { describe, expect, test } from "bun:test";
import { buildBridge, type Bridge } from "../cmux/bridge.ts";
import { createSnapshotLivenessReader } from "./liveness-cache.ts";

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolvePromise: ((value: T) => void) | null = null;
  let rejectPromise: ((error: Error) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value: T): void {
      if (resolvePromise === null) throw new Error("deferred promise was not initialized");
      resolvePromise(value);
    },
    reject(error: Error): void {
      if (rejectPromise === null) throw new Error("deferred promise was not initialized");
      rejectPromise(error);
    },
  };
}

function readableBridge(): Bridge {
  return buildBridge({ windows: [] }, {}, true);
}

function workspaceBridge(workspaceId: string): Bridge {
  return buildBridge({
    windows: [{
      id: `window-${workspaceId}`,
      ref: "window:1",
      workspaces: [{
        id: workspaceId,
        ref: "workspace:1",
        title: workspaceId,
        panes: [{
          id: `pane-${workspaceId}`,
          ref: "pane:1",
          index: 0,
          surfaces: [{ id: `surface-${workspaceId}`, ref: "surface:1", index_in_pane: 0 }],
        }],
      }],
    }],
  }, {}, true);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(0);
  }
  throw new Error("condition did not become true");
}

describe("snapshot liveness cache", () => {
  test("serves stale liveness while one expired refresh is pending", async () => {
    let clock = 0;
    let reads = 0;
    const refresh = deferred<Bridge>();
    const reader = createSnapshotLivenessReader({
      ttlMs: 10,
      now: () => clock,
      readBridge: async () => {
        reads += 1;
        return reads === 1 ? readableBridge() : refresh.promise;
      },
    });

    expect((await reader.read()).readable).toBeTrue();
    clock = 10;
    expect((await reader.read()).readable).toBeTrue();
    await Promise.resolve();
    expect(reads).toBe(2);
    expect((await reader.read()).readable).toBeTrue();
    expect(reads).toBe(2);

    refresh.resolve(readableBridge());
    await settle();
    expect((await reader.read()).readable).toBeTrue();
  });

  test("coalesces explicit hints into one refresh trailing an older in-flight read", async () => {
    let clock = 0;
    let reads = 0;
    const oldFlight = deferred<Bridge>();
    const reader = createSnapshotLivenessReader({
      ttlMs: 10,
      now: () => clock,
      readBridge: async () => {
        reads += 1;
        if (reads === 1) return workspaceBridge("initial");
        if (reads === 2) return oldFlight.promise;
        return workspaceBridge("post-action");
      },
    });

    expect((await reader.read()).workspaceIds()).toEqual(["initial"]);
    clock = 10;
    expect((await reader.read()).workspaceIds()).toEqual(["initial"]);
    await waitFor(() => reads === 2);

    reader.refresh();
    reader.refresh();
    reader.refresh();
    oldFlight.resolve(workspaceBridge("pre-action"));
    await waitFor(() => reads === 3);
    await settle();

    expect((await reader.read()).workspaceIds()).toEqual(["post-action"]);
    await Bun.sleep(0);
    expect(reads).toBe(3);
  });

  test("publishes fail-closed unreadability after a background refresh rejects", async () => {
    let reads = 0;
    const failed = deferred<Bridge>();
    const reader = createSnapshotLivenessReader({
      ttlMs: 60_000,
      readBridge: async () => {
        reads += 1;
        return reads === 1 ? readableBridge() : failed.promise;
      },
    });

    expect((await reader.read()).readable).toBeTrue();
    reader.refresh();
    await Promise.resolve();
    expect(reads).toBe(2);
    failed.reject(new Error("cmux socket unavailable"));
    await settle();
    await Bun.sleep(0);

    expect((await reader.read()).readable).toBeFalse();
  });

  test("runs a queued forced refresh after an older failure and keeps trailing failure fail-closed", async () => {
    let clock = 0;
    let reads = 0;
    const oldFailure = deferred<Bridge>();
    const trailingFailure = deferred<Bridge>();
    const reader = createSnapshotLivenessReader({
      ttlMs: 10,
      now: () => clock,
      readBridge: async () => {
        reads += 1;
        if (reads === 1) return readableBridge();
        return reads === 2 ? oldFailure.promise : trailingFailure.promise;
      },
    });

    expect((await reader.read()).readable).toBeTrue();
    clock = 10;
    expect((await reader.read()).readable).toBeTrue();
    await waitFor(() => reads === 2);
    reader.refresh();
    oldFailure.reject(new Error("older read failed"));
    await waitFor(() => reads === 3);
    expect((await reader.read()).readable).toBeFalse();

    trailingFailure.reject(new Error("forced trailing read failed"));
    await settle();
    await Bun.sleep(0);
    expect((await reader.read()).readable).toBeFalse();
    expect(reads).toBe(3);
  });

  test("a cold failure also returns an unreadable Bridge instead of an empty readable fleet", async () => {
    const reader = createSnapshotLivenessReader({
      ttlMs: 10,
      readBridge: async () => { throw new Error("cmux missing"); },
    });

    expect((await reader.read()).readable).toBeFalse();
  });
});
