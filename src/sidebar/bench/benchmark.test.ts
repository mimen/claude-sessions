import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import baseline from "../../../docs/evidence/sidebar-performance/baseline.json" with { type: "json" };
import {
  characterizeFixture,
  measureContention,
  measureEtagLoopback,
  normalizeRecommendationAlignment,
  sidebarPerformanceBudgetFailures,
  witnessDatabase,
} from "./benchmark.ts";
import { createSidebarFixture } from "./fixtures.ts";

function benchmarkDistribution(value: number, min = value) {
  return { samples: [value], min, p50: value, p95: value, max: value, mean: value };
}

/** Additive wire defaults do not rewrite the historical semantic golden. Dedicated T3 tests pin them. */
function omitT3Defaults<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (key === "t3Associated" && item === false) return undefined;
    if (key === "t3Count" && item === 0) return undefined;
    return item;
  })) as T;
}

async function withFixture<T>(
  options: { readonly sessionCount: number; readonly liveSessionCount: number },
  run: (fixture: ReturnType<typeof createSidebarFixture>) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "ccs-sidebar-benchmark-test-"));
  try {
    return await run(createSidebarFixture(root, options));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("sidebar performance characterization", () => {
  test("golden normalization changes only settled disagreement suggestions", () => {
    const input = {
      rows: [
        { id: "active", lifecycle: "active", suggestion: { verb: "archive" }, name: "A" },
        { id: "done", lifecycle: "completed", suggestion: { verb: "archive" }, name: "B" },
        { id: "parked", lifecycle: "active", catalogueLifecycle: "parked", suggestion: { verb: "complete" }, name: "C" },
      ],
      marker: "must remain",
    } as const;
    expect(normalizeRecommendationAlignment(input)).toEqual({
      rows: [
        { id: "active", lifecycle: "active", suggestion: { verb: "archive" }, name: "A" },
        { id: "done", lifecycle: "completed", suggestion: null, name: "B" },
        { id: "parked", lifecycle: "active", catalogueLifecycle: "parked", suggestion: null, name: "C" },
      ],
      marker: "must remain",
    });
  });

  test("captures every view and unreadable source without invoking real focus", async () => {
    await withFixture({ sessionCount: 8, liveSessionCount: 2 }, async (fixture) => {
      const result = await characterizeFixture(fixture, 3);

      expect(Object.keys(result.snapshotLatencyMs)).toEqual([
        "active",
        "triage",
        "completed",
        "saved",
      ]);
      expect(Object.keys(result.snapshots)).toEqual([
        "active",
        "triage",
        "completed",
        "saved",
        "unreadableCatalogue",
        "unreadableIndex",
        "unreadableLiveness",
      ]);
      expect(omitT3Defaults(normalizeRecommendationAlignment(result.snapshots))).toEqual(
        omitT3Defaults(normalizeRecommendationAlignment(baseline.golden.snapshots)),
      );
      expect(result.safeFocus.focusCalls).toBe(3);
      expect(result.safeFocus.outcomes).toEqual(["focused", "focused", "focused"]);
      expect(result.snapshotLatencyMs.active.samples).toHaveLength(3);
      expect(result.payloadBytes.active.min).toBeGreaterThan(0);
      expect(result.serializationMs.active.min).toBeGreaterThanOrEqual(0);
    });
  });

  test("ordinary characterization leaves generated SQLite files byte-identical", async () => {
    await withFixture({ sessionCount: 12, liveSessionCount: 2 }, async (fixture) => {
      const before = {
        catalogue: witnessDatabase(fixture.cataloguePath, fixture.root),
        index: witnessDatabase(fixture.indexPath, fixture.root),
      };
      await characterizeFixture(fixture, 3);
      const after = {
        catalogue: witnessDatabase(fixture.cataloguePath, fixture.root),
        index: witnessDatabase(fixture.indexPath, fixture.root),
      };

      expect(after).toEqual(before);
    });
  });
});

test("isolated benchmark budgets reject latency, semantics, contention, and witness regressions", () => {
  const healthy = {
    contention: {
      snapshotMs: 10,
      heartbeatTicks: 5,
      heartbeatLongestDelayMs: 2,
      catalogueReadable: true,
    },
    etagLoopback: {
      initialBodyBytes: 100,
      unchanged: { statuses: [304], bodyBytes: 0, latencyMs: benchmarkDistribution(2) },
      staleTrigger: { statuses: [304], bodyBytes: 0, latencyMs: benchmarkDistribution(3) },
      changedVisible: {
        statuses: [200],
        bodyBytes: benchmarkDistribution(100),
        latencyMs: benchmarkDistribution(20),
      },
    },
    readPathByteIdentical: true,
    logicalStateUnchanged: true,
  } as const;
  expect(sidebarPerformanceBudgetFailures(healthy)).toEqual([]);

  const failures = sidebarPerformanceBudgetFailures({
    ...healthy,
    contention: {
      ...healthy.contention,
      snapshotMs: 120,
      heartbeatLongestDelayMs: 50,
      catalogueReadable: false,
    },
    etagLoopback: {
      ...healthy.etagLoopback,
      unchanged: { statuses: [200], bodyBytes: 1, latencyMs: benchmarkDistribution(10) },
      staleTrigger: { statuses: [200], bodyBytes: 1, latencyMs: benchmarkDistribution(10) },
      changedVisible: {
        statuses: [304],
        bodyBytes: benchmarkDistribution(0),
        latencyMs: benchmarkDistribution(120),
      },
    },
    readPathByteIdentical: false,
    logicalStateUnchanged: false,
  });
  expect(failures).toContain("unchanged requests did not all return 304");
  expect(failures).toContain("stale-trigger requests did not all return 304");
  expect(failures).toContain("changed-visible requests did not all return 200");
  expect(failures).toContain("contention snapshot reported an unreadable catalogue");
  expect(failures).toContain("read-path database witnesses changed");
  expect(failures).toContain("benchmark fixture logical state changed");
  expect(failures.length).toBeGreaterThan(6);
});

test("Phase 2 semantics: stale polls stay fast while the next request exposes changed bytes", async () => {
  await withFixture({ sessionCount: 120, liveSessionCount: 8 }, async (fixture) => {
    const result = await measureEtagLoopback(fixture, 20);

    expect(new Set(result.unchanged.statuses)).toEqual(new Set([304]));
    expect(result.unchanged.bodyBytes).toBe(0);
    expect(new Set(result.staleTrigger.statuses)).toEqual(new Set([304]));
    expect(result.staleTrigger.bodyBytes).toBe(0);
    expect(new Set(result.changedVisible.statuses)).toEqual(new Set([200]));
    expect(result.changedVisible.bodyBytes.min).toBeGreaterThan(0);
    // Parallel unit runs are scheduler-loaded semantic checks, not the isolated measurement gate.
    expect(Math.max(
      result.unchanged.latencyMs.p95,
      result.staleTrigger.latencyMs.p95,
      result.changedVisible.latencyMs.p95,
    )).toBeLessThan(500);
  });
});

test(
  "Phase 1 semantics: held catalogue writer remains readable and nonblocking",
  async () => {
    await withFixture({ sessionCount: 12, liveSessionCount: 2 }, async (fixture) => {
      const result = await measureContention(fixture, 350);

      expect(result.catalogueReadable).toBeTrue();
      // The dedicated benchmark command owns strict contention and event-loop budgets.
      expect(result.snapshotMs).toBeLessThan(1_000);
      expect(result.heartbeatLongestDelayMs).toBeLessThan(500);
    });
  },
);
