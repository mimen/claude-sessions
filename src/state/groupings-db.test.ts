import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "../catalogue/db.ts";
import {
  appendNote,
  deleteGrouping,
  getGrouping,
  listGroupings,
  setClosed,
  upsertGrouping,
} from "./groupings-db.ts";
import { migrateGroupingsJsonToDb } from "./groupings-migrate.ts";

const NOW = "2026-07-14T12:00:00Z";

describe("groupings CRUD", () => {
  test("upsert then read", () => {
    const db = openCatalogue(":memory:");
    upsertGrouping(
      db,
      "epic-1",
      { cluster: "pr-watch", role: "pr-agent", label: "Team Tokens UI", url: "https://x/1" },
      NOW,
    );
    const g = getGrouping(db, "epic-1")!;
    expect(g.groupingId).toBe("epic-1");
    expect(g.label).toBe("Team Tokens UI");
    expect(g.url).toBe("https://x/1");
    expect(g.closed).toBe(false);
    expect(g.notes).toEqual([]);
  });

  test("upsert on existing preserves unmentioned fields", () => {
    const db = openCatalogue(":memory:");
    upsertGrouping(
      db,
      "epic-1",
      { cluster: "pr-watch", role: "pr-agent", label: "Team Tokens", url: "https://x/1" },
      NOW,
    );
    upsertGrouping(db, "epic-1", { cluster: "pr-watch", role: "pr-agent", shortName: "TT" }, NOW);
    const g = getGrouping(db, "epic-1")!;
    expect(g.label).toBe("Team Tokens");   // preserved
    expect(g.url).toBe("https://x/1");     // preserved
    expect(g.shortName).toBe("TT");        // set
  });

  test("explicit null clears a field", () => {
    const db = openCatalogue(":memory:");
    upsertGrouping(
      db,
      "epic-1",
      { cluster: "pr-watch", role: "pr-agent", label: "Team Tokens" },
      NOW,
    );
    upsertGrouping(db, "epic-1", { cluster: "pr-watch", role: "pr-agent", label: null }, NOW);
    expect(getGrouping(db, "epic-1")!.label).toBeNull();
  });

  test("appendNote adds unique notes", () => {
    const db = openCatalogue(":memory:");
    upsertGrouping(db, "epic-1", { cluster: "pr-watch", role: "pr-agent" }, NOW);
    appendNote(db, "epic-1", "pr-watch", "pr-agent", "first learning", NOW);
    appendNote(db, "epic-1", "pr-watch", "pr-agent", "second learning", NOW);
    appendNote(db, "epic-1", "pr-watch", "pr-agent", "first learning", NOW); // dup — skip
    const g = getGrouping(db, "epic-1")!;
    expect(g.notes).toEqual(["first learning", "second learning"]);
  });

  test("appendNote lazily creates the grouping if absent", () => {
    const db = openCatalogue(":memory:");
    appendNote(db, "epic-99", "pr-watch", "pr-agent", "lazy note", NOW);
    const g = getGrouping(db, "epic-99")!;
    expect(g).not.toBeNull();
    expect(g.notes).toEqual(["lazy note"]);
    expect(g.cluster).toBe("pr-watch");
    expect(g.role).toBe("pr-agent");
  });

  test("setClosed toggles the flag", () => {
    const db = openCatalogue(":memory:");
    upsertGrouping(db, "epic-1", { cluster: "pr-watch", role: "pr-agent" }, NOW);
    expect(getGrouping(db, "epic-1")!.closed).toBe(false);
    setClosed(db, "epic-1", true, NOW);
    expect(getGrouping(db, "epic-1")!.closed).toBe(true);
    setClosed(db, "epic-1", false, NOW);
    expect(getGrouping(db, "epic-1")!.closed).toBe(false);
  });

  test("deleteGrouping removes the row", () => {
    const db = openCatalogue(":memory:");
    upsertGrouping(db, "epic-1", { cluster: "pr-watch", role: "pr-agent" }, NOW);
    deleteGrouping(db, "epic-1");
    expect(getGrouping(db, "epic-1")).toBeNull();
  });
});

describe("listGroupings filters", () => {
  test("filter by cluster + role + closed", () => {
    const db = openCatalogue(":memory:");
    upsertGrouping(db, "e1", { cluster: "pr-watch", role: "pr-agent", label: "one" }, NOW);
    upsertGrouping(db, "e2", { cluster: "pr-watch", role: "pr-agent", label: "two" }, NOW);
    upsertGrouping(db, "e3", { cluster: "issue-watch", role: "issue-agent", label: "three" }, NOW);
    setClosed(db, "e2", true, NOW);

    expect(listGroupings(db, { cluster: "pr-watch" }).length).toBe(2);
    expect(listGroupings(db, { cluster: "issue-watch" }).length).toBe(1);
    expect(listGroupings(db, { role: "pr-agent" }).length).toBe(2);
    expect(listGroupings(db, { closed: true }).length).toBe(1);
    expect(listGroupings(db, { closed: false }).length).toBe(2);
    expect(listGroupings(db, { cluster: "pr-watch", closed: true }).length).toBe(1);
  });
});

describe("migrateGroupingsJsonToDb", () => {
  function seed(runtime: string, cluster: string, doc: Record<string, unknown>): void {
    const dir = join(runtime, "clusters", cluster, "cluster");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "groupings.json"), JSON.stringify(doc));
  }

  test("migrates enveloped and raw docs, idempotently", () => {
    const runtime = mkdtempSync(join(tmpdir(), "groupings-migrate-"));
    try {
      seed(runtime, "pr-watch", {
        schemaVersion: 1,
        updatedAt: NOW,
        source: "test",
        data: {
          "epic-1": { label: "Team Tokens UI", url: "https://x/1", shortName: "TT", notes: ["a", "b"] },
          "epic-2": { label: "Metered Pricing", url: "https://x/2", shortName: null, notes: [] },
        },
      });
      const db = openCatalogue(":memory:");
      const count = migrateGroupingsJsonToDb(db, runtime);
      expect(count).toBe(2);
      const e1 = getGrouping(db, "epic-1")!;
      expect(e1.label).toBe("Team Tokens UI");
      expect(e1.notes).toEqual(["a", "b"]);
      expect(e1.role).toBe("pr-agent"); // default for pr-watch
      // Second run: file has been renamed, so re-migrating discovers nothing (idempotent).
      expect(migrateGroupingsJsonToDb(db, runtime)).toBe(0);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  test("renames the source file after migrating", () => {
    const runtime = mkdtempSync(join(tmpdir(), "groupings-migrate-"));
    try {
      seed(runtime, "pr-watch", {
        data: { "epic-1": { label: "One" } },
      });
      const db = openCatalogue(":memory:");
      migrateGroupingsJsonToDb(db, runtime);
      const { existsSync } = require("node:fs");
      expect(existsSync(join(runtime, "clusters", "pr-watch", "cluster", "groupings.json"))).toBe(false);
      expect(existsSync(join(runtime, "clusters", "pr-watch", "cluster", "groupings.json.migrated"))).toBe(true);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  test("skips a cluster with no groupings.json", () => {
    const runtime = mkdtempSync(join(tmpdir(), "groupings-migrate-"));
    try {
      mkdirSync(join(runtime, "clusters", "empty-cluster", "cluster"), { recursive: true });
      const db = openCatalogue(":memory:");
      expect(migrateGroupingsJsonToDb(db, runtime)).toBe(0);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});
