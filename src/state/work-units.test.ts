import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getWorkUnit,
  allWorkUnits,
  mintWorkUnit,
  findWorkUnitByAnchor,
  attachAttributes,
} from "./work-units.ts";

const NOW = "2026-07-11T00:00:00Z";

function withRoot<T>(fn: () => T): T {
  const root = mkdtempSync(join(tmpdir(), "ccs-wu-"));
  const prev = process.env.CCS_ROOT;
  process.env.CCS_ROOT = root;
  try {
    return fn();
  } finally {
    prev === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = prev);
    rmSync(root, { recursive: true, force: true });
  }
}

test("mint a work-unit with PR anchor → deterministic id from PR", () => {
  withRoot(() => {
    const id = mintWorkUnit(
      "pr-watch",
      { prRepo: "acme/web", prNumber: 123, prState: "open" },
      NOW,
    );
    expect(id).toBe("wu_web_123"); // deterministic from repo + number
    const wu = getWorkUnit("pr-watch", id)!;
    expect(wu.prRepo).toBe("acme/web");
    expect(wu.prNumber).toBe(123);
    expect(wu.prState).toBe("open");
    expect(wu.gusWork).toBeNull();
    expect(wu.cluster).toBe("pr-watch");
  });
});

test("mint a work-unit with GUS anchor → deterministic id from GUS", () => {
  withRoot(() => {
    const id = mintWorkUnit("pr-watch", { gusWork: "W-12345678" }, NOW);
    expect(id).toBe("wu_W12345678"); // deterministic from GUS id
    const wu = getWorkUnit("pr-watch", id)!;
    expect(wu.gusWork).toBe("W-12345678");
    expect(wu.prNumber).toBeNull();
  });
});

test("mint a work-unit with no anchor → incrementing counter id", () => {
  withRoot(() => {
    const id1 = mintWorkUnit("pr-watch", { title: "exploratory work" }, NOW);
    expect(id1).toBe("wu_anon_1");
    const id2 = mintWorkUnit("pr-watch", { title: "another task" }, NOW);
    expect(id2).toBe("wu_anon_2");
    const id3 = mintWorkUnit("pr-watch", {}, NOW);
    expect(id3).toBe("wu_anon_3");
  });
});

test("minting the same PR anchor twice returns the same id (idempotent)", () => {
  withRoot(() => {
    const id1 = mintWorkUnit("pr-watch", { prRepo: "acme/api", prNumber: 456 }, NOW);
    const id2 = mintWorkUnit("pr-watch", { prRepo: "acme/api", prNumber: 456 }, NOW);
    expect(id1).toBe(id2);
    expect(Object.keys(allWorkUnits("pr-watch"))).toEqual([id1]); // only one work-unit
  });
});

test("findWorkUnitByAnchor finds by PR", () => {
  withRoot(() => {
    const id = mintWorkUnit("pr-watch", { prRepo: "acme/web", prNumber: 789 }, NOW);
    const found = findWorkUnitByAnchor("pr-watch", { prRepo: "acme/web", prNumber: 789 });
    expect(found).toBe(id);
  });
});

test("findWorkUnitByAnchor finds by GUS", () => {
  withRoot(() => {
    const id = mintWorkUnit("pr-watch", { gusWork: "W-99999999" }, NOW);
    const found = findWorkUnitByAnchor("pr-watch", { gusWork: "W-99999999" });
    expect(found).toBe(id);
  });
});

test("findWorkUnitByAnchor returns null when not found", () => {
  withRoot(() => {
    expect(findWorkUnitByAnchor("pr-watch", { prRepo: "acme/web", prNumber: 999 })).toBeNull();
    expect(findWorkUnitByAnchor("pr-watch", { gusWork: "W-00000000" })).toBeNull();
  });
});

test("attachAttributes updates attributes on an existing work-unit", () => {
  withRoot(() => {
    const id = mintWorkUnit("pr-watch", { title: "initial" }, NOW);
    expect(getWorkUnit("pr-watch", id)!.prNumber).toBeNull();

    attachAttributes("pr-watch", id, { prRepo: "acme/web", prNumber: 123 }, NOW);
    const wu = getWorkUnit("pr-watch", id)!;
    expect(wu.prRepo).toBe("acme/web");
    expect(wu.prNumber).toBe(123);
    expect(wu.title).toBe("initial"); // preserved
  });
});

test("attachAttributes merges — only provided fields are updated", () => {
  withRoot(() => {
    const id = mintWorkUnit("pr-watch", { prRepo: "acme/api", prNumber: 5, title: "fix" }, NOW);
    attachAttributes("pr-watch", id, { prState: "merged", gusWork: "W-11111111" }, NOW);
    const wu = getWorkUnit("pr-watch", id)!;
    expect(wu.prRepo).toBe("acme/api"); // preserved
    expect(wu.prNumber).toBe(5); // preserved
    expect(wu.prState).toBe("merged"); // added
    expect(wu.gusWork).toBe("W-11111111"); // added
    expect(wu.title).toBe("fix"); // preserved
  });
});

test("attachAttributes throws if work-unit not found", () => {
  withRoot(() => {
    expect(() => attachAttributes("pr-watch", "wu_missing", { title: "nope" }, NOW)).toThrow(
      /work-unit wu_missing not found/,
    );
  });
});

test("allWorkUnits returns every work-unit id for a cluster", () => {
  withRoot(() => {
    mintWorkUnit("pr-watch", { prRepo: "a/b", prNumber: 1 }, NOW);
    mintWorkUnit("pr-watch", { gusWork: "W-22222222" }, NOW);
    const all = allWorkUnits("pr-watch");
    expect(Object.keys(all).sort()).toEqual(["wu_W22222222", "wu_b_1"]);
  });
});

test("work-units are per-cluster (no cross-leak)", () => {
  withRoot(() => {
    const id1 = mintWorkUnit("pr-watch", { prRepo: "acme/web", prNumber: 100 }, NOW);
    const id2 = mintWorkUnit("event-watch", { prRepo: "acme/web", prNumber: 100 }, NOW);
    expect(id1).toBe("wu_web_100");
    expect(id2).toBe("wu_web_100"); // same derived id, but different clusters
    expect(getWorkUnit("pr-watch", id1)!.cluster).toBe("pr-watch");
    expect(getWorkUnit("event-watch", id2)!.cluster).toBe("event-watch");
  });
});

test("find-or-create reconnection: second spawn finds existing work-unit by anchor", () => {
  withRoot(() => {
    // First spawn: mint a work-unit for PR 123
    const id1 = mintWorkUnit("pr-watch", { prRepo: "acme/web", prNumber: 123 }, NOW);
    expect(id1).toBe("wu_web_123");

    // Second spawn: look up by anchor before minting
    const found = findWorkUnitByAnchor("pr-watch", { prRepo: "acme/web", prNumber: 123 });
    expect(found).toBe(id1); // reconnected to the same work-unit

    // If not found, THEN mint (but here it's found, so no-op)
    const id2 = found ?? mintWorkUnit("pr-watch", { prRepo: "acme/web", prNumber: 123 }, NOW);
    expect(id2).toBe(id1); // same id
    expect(Object.keys(allWorkUnits("pr-watch"))).toEqual([id1]); // only one work-unit
  });
});

test("anchorless work-unit stays isolated (no auto-reconnection)", () => {
  withRoot(() => {
    // Two separate anchorless spawns → two distinct work-units
    const id1 = mintWorkUnit("pr-watch", { title: "exploratory A" }, NOW);
    const id2 = mintWorkUnit("pr-watch", { title: "exploratory B" }, NOW);
    expect(id1).not.toBe(id2);
    expect(Object.keys(allWorkUnits("pr-watch")).sort()).toEqual(["wu_anon_1", "wu_anon_2"]);
  });
});

test("PR attaches to an existing anchorless work-unit (attribute update)", () => {
  withRoot(() => {
    // Start work with no anchor
    const id = mintWorkUnit("pr-watch", { title: "initial exploration" }, NOW);
    expect(id).toBe("wu_anon_1");
    expect(getWorkUnit("pr-watch", id)!.prNumber).toBeNull();

    // Later, the work gets a PR → attach it
    attachAttributes("pr-watch", id, { prRepo: "acme/web", prNumber: 500 }, NOW);
    const wu = getWorkUnit("pr-watch", id)!;
    expect(wu.prRepo).toBe("acme/web");
    expect(wu.prNumber).toBe(500);
    expect(wu.id).toBe("wu_anon_1"); // id doesn't change

    // A second session for PR 500 now finds this work-unit by anchor
    const found = findWorkUnitByAnchor("pr-watch", { prRepo: "acme/web", prNumber: 500 });
    expect(found).toBe(id);
  });
});
