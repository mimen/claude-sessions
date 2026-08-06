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

  test("a cold read awaits and suppresses one transient unreadable Bridge", async () => {
    let reads = 0;
    let completed = false;
    const retry = deferred<Bridge>();
    const reader = createSnapshotLivenessReader({
      ttlMs: 10,
      readBridge: async () => {
        reads += 1;
        return reads === 1 ? buildBridge({ windows: [] }, {}, false) : retry.promise;
      },
    });

    const coldRead = reader.read().then((bridge) => {
      completed = true;
      return bridge;
    });
    await waitFor(() => reads === 2);
    expect(completed).toBeFalse();

    retry.resolve(workspaceBridge("retry"));
    expect((await coldRead).workspaceIds()).toEqual(["retry"]);
    expect(reads).toBe(2);
  });

  test("suppresses one transient rejected liveness read", async () => {
    let reads = 0;
    const reader = createSnapshotLivenessReader({
      ttlMs: 10,
      readBridge: async () => {
        reads += 1;
        if (reads === 1) throw new Error("cmux socket unavailable");
        return workspaceBridge("retry");
      },
    });

    expect((await reader.read()).workspaceIds()).toEqual(["retry"]);
    expect(reads).toBe(2);
  });

  test("publishes fail-closed unreadability only after both refresh attempts fail", async () => {
    let reads = 0;
    const reader = createSnapshotLivenessReader({
      ttlMs: 60_000,
      readBridge: async () => {
        reads += 1;
        if (reads === 1) return readableBridge();
        if (reads === 2) return buildBridge({ windows: [] }, {}, false);
        throw new Error("cmux socket unavailable");
      },
    });

    expect((await reader.read()).readable).toBeTrue();
    reader.refresh();
    await waitFor(() => reads === 3);
    await settle();

    expect((await reader.read()).readable).toBeFalse();
    expect(reads).toBe(3);
  });

  test("queues one forced trailing refresh behind both attempts of the current refresh", async () => {
    let clock = 0;
    let reads = 0;
    const oldRetry = deferred<Bridge>();
    const reader = createSnapshotLivenessReader({
      ttlMs: 10,
      now: () => clock,
      readBridge: async () => {
        reads += 1;
        if (reads === 1) return workspaceBridge("initial");
        if (reads === 2 || reads === 4) return buildBridge({ windows: [] }, {}, false);
        if (reads === 3) return oldRetry.promise;
        return workspaceBridge("post-action");
      },
    });

    expect((await reader.read()).workspaceIds()).toEqual(["initial"]);
    clock = 10;
    expect((await reader.read()).workspaceIds()).toEqual(["initial"]);
    await waitFor(() => reads === 3);

    reader.refresh();
    reader.refresh();
    reader.refresh();
    expect((await reader.read()).workspaceIds()).toEqual(["initial"]);

    oldRetry.resolve(workspaceBridge("pre-action"));
    await waitFor(() => reads === 5);
    await settle();

    expect((await reader.read()).workspaceIds()).toEqual(["post-action"]);
    await Bun.sleep(0);
    expect(reads).toBe(5);
  });
});
