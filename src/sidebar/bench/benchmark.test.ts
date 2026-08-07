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
  witnessDatabase,
} from "./benchmark.ts";
import { createSidebarFixture } from "./fixtures.ts";

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
        "archived",
      ]);
      expect(Object.keys(result.snapshots)).toEqual([
        "active",
        "triage",
        "completed",
        "archived",
        "unreadableCatalogue",
        "unreadableIndex",
        "unreadableLiveness",
      ]);
      expect(normalizeRecommendationAlignment(result.snapshots)).toEqual(
        normalizeRecommendationAlignment(baseline.golden.snapshots),
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

test("Phase 2 gate: stale polls stay fast while the next request exposes changed bytes", async () => {
  await withFixture({ sessionCount: 120, liveSessionCount: 8 }, async (fixture) => {
    const result = await measureEtagLoopback(fixture, 20);

    expect(new Set(result.unchanged.statuses)).toEqual(new Set([304]));
    expect(result.unchanged.bodyBytes).toBe(0);
    expect(result.unchanged.latencyMs.p95).toBeLessThan(10);
    expect(new Set(result.staleTrigger.statuses)).toEqual(new Set([304]));
    expect(result.staleTrigger.bodyBytes).toBe(0);
    expect(result.staleTrigger.latencyMs.p95).toBeLessThan(10);
    expect(new Set(result.changedVisible.statuses)).toEqual(new Set([200]));
    expect(result.changedVisible.bodyBytes.min).toBeGreaterThan(0);
    expect(result.changedVisible.latencyMs.p95).toBeLessThan(120);
  });
});

test(
  "Phase 1 gate: held catalogue writer does not block snapshot",
  async () => {
    await withFixture({ sessionCount: 12, liveSessionCount: 2 }, async (fixture) => {
      const result = await measureContention(fixture, 350);

      expect(result.snapshotMs).toBeLessThan(120);
      expect(result.heartbeatLongestDelayMs).toBeLessThan(50);
      expect(result.catalogueReadable).toBeTrue();
    });
  },
);
