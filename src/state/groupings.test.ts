import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGrouping, allGroupings, upsertGrouping, appendGroupingNote } from "./groupings.ts";

const NOW = "2026-07-10T00:00:00Z";

function withRoot<T>(fn: () => T): T {
  const root = mkdtempSync(join(tmpdir(), "ccs-grp-"));
  const prev = process.env.CCS_ROOT;
  process.env.CCS_ROOT = root;
  try { return fn(); }
  finally {
    prev === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = prev);
    rmSync(root, { recursive: true, force: true });
  }
}

test("upsert then read a grouping's sensed metadata", () => {
  withRoot(() => {
    upsertGrouping("pr-watch", "e1", { label: "Metered Pricing", url: "https://gus/e1", shortName: "Metered" }, NOW);
    const g = getGrouping("pr-watch", "e1")!;
    expect(g.label).toBe("Metered Pricing");
    expect(g.url).toBe("https://gus/e1");
    expect(g.shortName).toBe("Metered");
    expect(g.notes).toEqual([]);
  });
});

test("upsert preserves accumulated notes (metadata + notes are separate writes)", () => {
  withRoot(() => {
    appendGroupingNote("pr-watch", "e1", "3.sdk shape changed again", NOW);
    upsertGrouping("pr-watch", "e1", { label: "Metered" }, NOW); // sensor re-writes metadata
    const g = getGrouping("pr-watch", "e1")!;
    expect(g.label).toBe("Metered");
    expect(g.notes).toEqual(["3.sdk shape changed again"]); // survived the metadata upsert
  });
});

test("appendGroupingNote de-dupes exact repeats + creates the grouping if absent", () => {
  withRoot(() => {
    appendGroupingNote("pr-watch", "e2", "flag flipped 2026-05-26", NOW);
    appendGroupingNote("pr-watch", "e2", "flag flipped 2026-05-26", NOW); // dup
    appendGroupingNote("pr-watch", "e2", "CX deferred to end-of-epic", NOW);
    expect(getGrouping("pr-watch", "e2")!.notes).toEqual(["flag flipped 2026-05-26", "CX deferred to end-of-epic"]);
  });
});

test("allGroupings returns every grouping id for a cluster", () => {
  withRoot(() => {
    upsertGrouping("pr-watch", "a", { label: "A" }, NOW);
    upsertGrouping("pr-watch", "b", { label: "B" }, NOW);
    expect(Object.keys(allGroupings("pr-watch")).sort()).toEqual(["a", "b"]);
  });
});

test("groupings are per-cluster (no cross-leak)", () => {
  withRoot(() => {
    upsertGrouping("pr-watch", "x", { label: "PW" }, NOW);
    upsertGrouping("event-watch", "x", { label: "EW" }, NOW);
    expect(getGrouping("pr-watch", "x")!.label).toBe("PW");
    expect(getGrouping("event-watch", "x")!.label).toBe("EW");
  });
});

test("empty/blank note is ignored", () => {
  withRoot(() => {
    appendGroupingNote("pr-watch", "e", "   ", NOW);
    expect(getGrouping("pr-watch", "e")).toBeNull();
  });
});

import { groupingCommand } from "./grouping-command.ts";

test("ccs grouping set + get + note via the command layer", () => {
  withRoot(() => {
    expect(groupingCommand(["set", "--cluster", "pr-watch", "e9", "--label", "[FE] Metered Pricing", "--url", "https://gus/e9"])).toBe(0);
    const g = getGrouping("pr-watch", "e9")!;
    expect(g.label).toBe("[FE] Metered Pricing");
    expect(g.url).toBe("https://gus/e9");
    expect(g.shortName).toBe("Metered Pricing"); // derived from label
    expect(groupingCommand(["note", "--cluster", "pr-watch", "e9", "--note", "3.sdk changed"])).toBe(0);
    expect(getGrouping("pr-watch", "e9")!.notes).toEqual(["3.sdk changed"]);
  });
});

test("ccs grouping set: a manual --short is STICKY — a later sensor set --label doesn't clobber it", () => {
  withRoot(() => {
    // human sets a readable short
    groupingCommand(["set", "--cluster", "pr-watch", "e5", "--short", "PP→Dashboard"]);
    expect(getGrouping("pr-watch", "e5")!.shortName).toBe("PP→Dashboard");
    // sensor re-runs each tick with just the (long) label — must NOT re-derive over the manual short
    groupingCommand(["set", "--cluster", "pr-watch", "e5", "--label", "[Front End] FY27 Migrate Partner Portal into Dashboard", "--from", "catalogue-sync"]);
    const g = getGrouping("pr-watch", "e5")!;
    expect(g.shortName).toBe("PP→Dashboard"); // survived the sensor
    expect(g.label).toBe("[Front End] FY27 Migrate Partner Portal into Dashboard"); // label still updated
  });
});

test("ccs grouping: missing --cluster or id errors", () => {
  expect(groupingCommand(["set", "e1"])).toBe(1);            // no --cluster
  expect(groupingCommand(["set", "--cluster", "c"])).toBe(1); // no id
});
