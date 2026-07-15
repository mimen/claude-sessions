import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGrouping,
  allGroupings,
  allGroupingsAcrossClusters,
  upsertGrouping,
  appendGroupingNote,
  deriveShortName,
} from "./groupings.ts";
import { groupingCommand } from "./grouping-command.ts";

const NOW = "2026-07-10T00:00:00Z";

/**
 * ADR-0089 step 4: these tests cover the compatibility shim (src/state/groupings.ts) that
 * routes reads/writes through the DB-backed groupings table. The full DB behavior is exercised
 * in groupings-db.test.ts; this file only checks that the shim exposes the same-shaped API
 * pre-refactor callers were using, plus that the new `ccs grouping` CLI works.
 *
 * Note about cross-cluster identity: grouping_id is now globally unique (opaque tracker id).
 * The pre-refactor per-cluster-scoped id test is retired since the same tracker id shouldn't
 * legitimately appear in two clusters. The shim ignores the passed `cluster` arg on read.
 */

function withRoot<T>(fn: () => T): T {
  const root = mkdtempSync(join(tmpdir(), "ccs-grp-"));
  const prev = process.env.CCS_ROOT;
  process.env.CCS_ROOT = root;
  try {
    return fn();
  } finally {
    prev === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = prev);
    rmSync(root, { recursive: true, force: true });
  }
}

test("shim: upsert then read a grouping's sensed metadata", () => {
  withRoot(() => {
    upsertGrouping("pr-watch", "e1", { label: "Metered Pricing", url: "https://gus/e1", shortName: "Metered" }, NOW);
    const g = getGrouping("pr-watch", "e1")!;
    expect(g.label).toBe("Metered Pricing");
    expect(g.url).toBe("https://gus/e1");
    expect(g.shortName).toBe("Metered");
    expect(g.notes).toEqual([]);
  });
});

test("shim: upsert preserves accumulated notes", () => {
  withRoot(() => {
    appendGroupingNote("pr-watch", "e1", "3.sdk shape changed again", NOW);
    upsertGrouping("pr-watch", "e1", { label: "Metered" }, NOW);
    const g = getGrouping("pr-watch", "e1")!;
    expect(g.label).toBe("Metered");
    expect(g.notes).toEqual(["3.sdk shape changed again"]);
  });
});

test("shim: appendGroupingNote de-dupes exact repeats + creates the grouping if absent", () => {
  withRoot(() => {
    appendGroupingNote("pr-watch", "e2", "flag flipped 2026-05-26", NOW);
    appendGroupingNote("pr-watch", "e2", "flag flipped 2026-05-26", NOW);
    appendGroupingNote("pr-watch", "e2", "CX deferred to end-of-epic", NOW);
    expect(getGrouping("pr-watch", "e2")!.notes).toEqual([
      "flag flipped 2026-05-26",
      "CX deferred to end-of-epic",
    ]);
  });
});

test("shim: allGroupings returns every grouping id for a cluster", () => {
  withRoot(() => {
    upsertGrouping("pr-watch", "a", { label: "A" }, NOW);
    upsertGrouping("pr-watch", "b", { label: "B" }, NOW);
    expect(Object.keys(allGroupings("pr-watch")).sort()).toEqual(["a", "b"]);
  });
});

test("shim: allGroupingsAcrossClusters returns every grouping in the DB", () => {
  withRoot(() => {
    upsertGrouping("pr-watch", "a", { label: "A" }, NOW);
    upsertGrouping("issue-watch", "b", { label: "B" }, NOW);
    const all = allGroupingsAcrossClusters();
    expect(all.size).toBe(2);
    expect(all.get("a")!.label).toBe("A");
    expect(all.get("b")!.label).toBe("B");
  });
});

test("shim: empty/blank note is ignored", () => {
  withRoot(() => {
    appendGroupingNote("pr-watch", "e", "   ", NOW);
    expect(getGrouping("pr-watch", "e")).toBeNull();
  });
});

test("deriveShortName is unchanged", () => {
  expect(deriveShortName("[Front End] FY27 Metered Pricing & Usage Transparency")).toBe("Metered Pricing");
  expect(deriveShortName("Team Tokens UI")).toBe("Team Tokens UI");
  expect(deriveShortName(null)).toBeNull();
});

// ── CLI shape (new grouping-command.ts) ────────────────────────────────────────

test("ccs grouping upsert + read via bare-id form", () => {
  withRoot(() => {
    expect(
      groupingCommand([
        "upsert",
        "e9",
        "--cluster=pr-watch",
        "--role=pr-agent",
        "--label=[FE] Metered Pricing",
        "--url=https://gus/e9",
      ]),
    ).toBe(0);
    expect(getGrouping("pr-watch", "e9")!.label).toBe("[FE] Metered Pricing");
    expect(getGrouping("pr-watch", "e9")!.url).toBe("https://gus/e9");
  });
});

test("ccs grouping set updates a field on an existing grouping", () => {
  withRoot(() => {
    groupingCommand(["upsert", "e5", "--cluster=pr-watch", "--role=pr-agent", "--short_name=PP→Dashboard"]);
    // Later sensor set with only --label must NOT clobber short_name (partial update semantics).
    groupingCommand([
      "set",
      "e5",
      "--label=[Front End] FY27 Migrate Partner Portal into Dashboard",
    ]);
    const g = getGrouping("pr-watch", "e5")!;
    expect(g.shortName).toBe("PP→Dashboard");
    expect(g.label).toBe("[Front End] FY27 Migrate Partner Portal into Dashboard");
  });
});

test("ccs grouping note-add appends", () => {
  withRoot(() => {
    groupingCommand(["upsert", "e10", "--cluster=pr-watch", "--role=pr-agent", "--label=X"]);
    expect(groupingCommand(["note-add", "e10", "hello", "world"])).toBe(0);
    expect(getGrouping("pr-watch", "e10")!.notes).toEqual(["hello world"]);
  });
});

test("ccs grouping unset clears a field", () => {
  withRoot(() => {
    groupingCommand(["upsert", "e11", "--cluster=pr-watch", "--role=pr-agent", "--label=Kept", "--url=https://x"]);
    expect(groupingCommand(["unset", "e11", "--url"])).toBe(0);
    expect(getGrouping("pr-watch", "e11")!.url).toBeNull();
    expect(getGrouping("pr-watch", "e11")!.label).toBe("Kept");
  });
});

test("ccs grouping close/reopen toggles the flag", () => {
  withRoot(() => {
    groupingCommand(["upsert", "e12", "--cluster=pr-watch", "--role=pr-agent"]);
    expect(groupingCommand(["close", "e12"])).toBe(0);
    groupingCommand(["upsert", "e12", "--cluster=pr-watch", "--role=pr-agent"]); // re-upsert doesn't reopen
    // reopen via explicit verb
    expect(groupingCommand(["reopen", "e12"])).toBe(0);
  });
});

test("ccs grouping upsert without cluster+role on a new id errors", () => {
  withRoot(() => {
    expect(groupingCommand(["upsert", "brand-new-id"])).toBe(1);
  });
});
