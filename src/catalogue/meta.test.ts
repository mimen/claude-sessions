import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openCatalogue, setMeta, getMeta, getRow, ensureRow } from "./db.ts";

const NOW = "2026-07-11T12:00:00Z";

function withDb<T>(fn: (db: Database) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "ccs-meta-"));
  const db = openCatalogue(join(tmp, "catalogue.db"));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("setMeta: set a key in the meta map", () => {
  withDb((db) => {
    setMeta(db, "s1", "latch_A", true, NOW);
    const row = getRow(db, "s1")!;
    expect(getMeta(row, "latch_A")).toBe(true);
  });
});

test("setMeta: merge multiple keys", () => {
  withDb((db) => {
    setMeta(db, "s1", "latch_A", true, NOW);
    setMeta(db, "s1", "counter_B", 42, NOW);
    setMeta(db, "s1", "flag_C", "active", NOW);
    const row = getRow(db, "s1")!;
    expect(getMeta(row, "latch_A")).toBe(true);
    expect(getMeta(row, "counter_B")).toBe(42);
    expect(getMeta(row, "flag_C")).toBe("active");
  });
});

test("setMeta: overwrite an existing key", () => {
  withDb((db) => {
    setMeta(db, "s1", "counter", 1, NOW);
    setMeta(db, "s1", "counter", 2, NOW);
    const row = getRow(db, "s1")!;
    expect(getMeta(row, "counter")).toBe(2);
  });
});

test("setMeta: delete a key by setting it to null", () => {
  withDb((db) => {
    setMeta(db, "s1", "temp_flag", "yes", NOW);
    expect(getMeta(getRow(db, "s1")!, "temp_flag")).toBe("yes");

    setMeta(db, "s1", "temp_flag", null, NOW);
    expect(getMeta(getRow(db, "s1")!, "temp_flag")).toBeUndefined();
  });
});

test("getMeta: returns undefined for absent key", () => {
  withDb((db) => {
    setMeta(db, "s1", "present", "value", NOW);
    const row = getRow(db, "s1")!;
    expect(getMeta(row, "missing")).toBeUndefined();
  });
});

test("setMeta: works with various JSON-serializable types", () => {
  withDb((db) => {
    setMeta(db, "s1", "bool", true, NOW);
    setMeta(db, "s1", "num", 123, NOW);
    setMeta(db, "s1", "str", "hello", NOW);
    setMeta(db, "s1", "obj", { nested: "value" }, NOW);
    setMeta(db, "s1", "arr", [1, 2, 3], NOW);

    const row = getRow(db, "s1")!;
    expect(getMeta(row, "bool")).toBe(true);
    expect(getMeta(row, "num")).toBe(123);
    expect(getMeta(row, "str")).toBe("hello");
    expect(getMeta(row, "obj")).toEqual({ nested: "value" });
    expect(getMeta(row, "arr")).toEqual([1, 2, 3]);
  });
});

test("setMeta: creates row if absent (ensureRow semantics)", () => {
  withDb((db) => {
    // No ensureRow call — setMeta should create the row
    setMeta(db, "s99", "key", "value", NOW);
    const row = getRow(db, "s99")!;
    expect(row.sessionId).toBe("s99");
    expect(getMeta(row, "key")).toBe("value");
  });
});

test("setMeta: preserves other meta keys when updating one", () => {
  withDb((db) => {
    setMeta(db, "s1", "keyA", "valueA", NOW);
    setMeta(db, "s1", "keyB", "valueB", NOW);
    setMeta(db, "s1", "keyA", "updatedA", NOW); // update keyA

    const row = getRow(db, "s1")!;
    expect(getMeta(row, "keyA")).toBe("updatedA");
    expect(getMeta(row, "keyB")).toBe("valueB"); // preserved
  });
});

test("meta map initializes as empty object for new rows", () => {
  withDb((db) => {
    ensureRow(db, "s1", NOW);
    const row = getRow(db, "s1")!;
    expect(row.meta).toEqual({});
  });
});
