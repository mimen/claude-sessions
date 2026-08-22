import { describe, expect, test } from "bun:test";
import type { CmuxChangeScope, CmuxEventSubscriptionOptions } from "../cmux/events.ts";
import { startSidebarChangeMonitor } from "./change-monitor.ts";

interface FakeSource {
  invalidate(scopes: Iterable<CmuxChangeScope>): void;
  reconcileDurableState(): void;
  close?(): void;
}

describe("startSidebarChangeMonitor", () => {
  test("combines cmux invalidations and durable reconciliation behind one lifecycle", () => {
    const invalidations: CmuxChangeScope[][] = [];
    let reconciliations = 0;
    let cmuxStopped = false;
    let timerStopped = false;
    let sourceClosed = false;
    let onCmuxChange: CmuxEventSubscriptionOptions["onChange"] | undefined;
    let tick: (() => void) | undefined;
    const source: FakeSource = {
      invalidate: (scopes) => invalidations.push([...scopes]),
      reconcileDurableState: () => {
        reconciliations += 1;
      },
      close: () => {
        sourceClosed = true;
      },
    };

    const monitor = startSidebarChangeMonitor({
      source,
      subscribe: (options) => {
        onCmuxChange = options.onChange;
        return { stop: () => { cmuxStopped = true; } };
      },
      scheduleEvery: (callback, intervalMs) => {
        expect(intervalMs).toBe(1_000);
        tick = callback;
        return { stop: () => { timerStopped = true; } };
      },
    });

    onCmuxChange?.(new Set(["liveness", "status"]));
    tick?.();
    expect(invalidations).toEqual([["liveness", "status"]]);
    expect(reconciliations).toBe(1);

    monitor.stop();
    expect(cmuxStopped).toBe(true);
    expect(timerStopped).toBe(true);
    expect(sourceClosed).toBe(true);
  });

  test("contains durable probe failures so the resident monitor keeps running", () => {
    const warnings: string[] = [];
    let tick: (() => void) | undefined;
    const source: FakeSource = {
      invalidate: () => {},
      reconcileDurableState: () => {
        throw new Error("catalogue replaced mid-probe");
      },
    };

    const monitor = startSidebarChangeMonitor({
      source,
      subscribe: () => ({ stop: () => {} }),
      scheduleEvery: (callback) => {
        tick = callback;
        return { stop: () => {} };
      },
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    expect(() => tick?.()).not.toThrow();
    expect(warnings).toEqual(["sidebar durable-state reconciliation failed"]);
    monitor.stop();
  });
});
