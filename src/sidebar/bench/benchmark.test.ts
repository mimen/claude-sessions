import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  characterizeFixture,
  measureContention,
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
  test("captures every view and unreadable source without invoking real focus", async () => {
    await withFixture({ sessionCount: 16, liveSessionCount: 3 }, async (fixture) => {
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

const contentionGate = process.env.CCS_SIDEBAR_CONTENTION_GATE === "1" ? test : test.skip;
contentionGate(
  "Phase 1 gate: held catalogue writer does not block snapshot or heartbeat",
  async () => {
    await withFixture({ sessionCount: 12, liveSessionCount: 2 }, async (fixture) => {
      const result = await measureContention(fixture, 350);
      expect(result.snapshotMs).toBeLessThan(120);
      expect(result.heartbeatTicks).toBeGreaterThan(0);
    });
  },
);
