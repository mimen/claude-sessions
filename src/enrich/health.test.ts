import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSweepHealth,
  recordSweepFailure,
  recordSweepSuccess,
  sweepWarning,
  hoursSinceSuccess,
} from "./health.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccs-health-"));
  path = join(dir, "enrich-health.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = "2026-07-26T06:00:00.000Z";
const at = (iso: string) => new Date(iso);

describe("sweep health", () => {
  test("a missing file reads as never-ran rather than throwing", () => {
    // A fresh machine must not make every reading surface crash on startup.
    expect(readSweepHealth(path)).toEqual({
      lastSuccessAt: null,
      lastSuccessEnriched: 0,
      consecutiveFailures: 0,
      lastFailure: null,
      lastFailureAt: null,
    });
  });

  test("a corrupt file reads as never-ran too", () => {
    writeFileSync(path, "{ not json", "utf8");
    expect(readSweepHealth(path).lastSuccessAt).toBeNull();
  });

  test("success records the time and clears the failure streak", () => {
    recordSweepFailure("gateway down", NOW, path);
    recordSweepFailure("gateway down", NOW, path);
    expect(readSweepHealth(path).consecutiveFailures).toBe(2);
    recordSweepSuccess(19, NOW, path);
    const health = readSweepHealth(path);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastFailure).toBeNull();
    expect(health.lastSuccessEnriched).toBe(19);
  });

  test("failures accumulate and keep the last reason", () => {
    recordSweepFailure("index schema version 12 is newer than supported version 11", NOW, path);
    recordSweepFailure("index schema version 12 is newer than supported version 11", NOW, path);
    const health = readSweepHealth(path);
    expect(health.consecutiveFailures).toBe(2);
    expect(health.lastFailure).toMatch(/index schema version 12/);
  });

  test("a runaway failure reason is truncated, not stored whole", () => {
    recordSweepFailure("x".repeat(5_000), NOW, path);
    expect(readSweepHealth(path).lastFailure!.length).toBeLessThanOrEqual(300);
  });
});

describe("sweepWarning", () => {
  test("a recent successful sweep warns about nothing", () => {
    recordSweepSuccess(3, "2026-07-26T05:30:00.000Z", path);
    expect(sweepWarning(readSweepHealth(path), at(NOW))).toBeNull();
  });

  test("silence is not the default — a five-hour outage is reported", () => {
    // The real incident: 42 crash-looped runs over ~5 hours, discovered by accident weeks later.
    recordSweepSuccess(40, "2026-07-26T00:45:00.000Z", path);
    for (let i = 0; i < 42; i++) recordSweepFailure("index schema version 12 is newer", NOW, path);
    const warning = sweepWarning(readSweepHealth(path), at(NOW));
    expect(warning).toMatch(/last succeeded 5h ago/);
    expect(warning).toMatch(/42 failed runs/);
    expect(warning).toMatch(/index schema version 12/);
  });

  test("a healthy but slow store still warns once it passes the age backstop", () => {
    // Six hours matches the freshness rule's own backstop: the sweep is called unhealthy exactly
    // when it has been down long enough for that rule to have wanted to fire.
    recordSweepSuccess(0, "2026-07-25T20:00:00.000Z", path);
    expect(sweepWarning(readSweepHealth(path), at(NOW))).toMatch(/last succeeded 10h ago/);
  });

  test("long outages read in days, not three-digit hours", () => {
    recordSweepSuccess(0, "2026-07-01T06:00:00.000Z", path);
    expect(sweepWarning(readSweepHealth(path), at(NOW))).toMatch(/25d ago/);
  });

  test("never succeeded but failing is reported; never run at all is silent", () => {
    expect(sweepWarning(readSweepHealth(path), at(NOW))).toBeNull();
    recordSweepFailure("Unknown command: enrich", NOW, path);
    expect(sweepWarning(readSweepHealth(path), at(NOW))).toMatch(/has never succeeded/);
  });

  test("hoursSinceSuccess survives a garbage timestamp", () => {
    writeFileSync(path, JSON.stringify({ lastSuccessAt: "not-a-date" }), "utf8");
    expect(hoursSinceSuccess(readSweepHealth(path), at(NOW))).toBeNull();
  });
});
