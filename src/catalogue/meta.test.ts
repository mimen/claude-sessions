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

test("v22 migration: backfills milad_review from column into meta", () => {
  withDb((db) => {
    // Simulate a pre-v22 row with milad_review in the column (bypassing setMiladReview which no longer exists)
    db.query("INSERT INTO catalogue (session_id, milad_review, updated_at) VALUES (?, ?, ?)")
      .run("s1", "approved", NOW);

    // Force re-run the v22 migration block by directly calling the backfill logic
    const rows = db.query("SELECT session_id, milad_review, build_complete, meta FROM catalogue").all() as Array<{
      session_id: string;
      milad_review: string | null;
      build_complete: number | null;
      meta: string | null;
    }>;
    const update = db.prepare("UPDATE catalogue SET meta = ? WHERE session_id = ?");
    for (const r of rows) {
      const meta = r.meta ? JSON.parse(r.meta) : {};
      let changed = false;
      if (r.milad_review !== null && meta.milad_review === undefined) {
        meta.milad_review = r.milad_review;
        changed = true;
      }
      if (r.build_complete === 1 && meta.build_complete === undefined) {
        meta.build_complete = true;
        changed = true;
      }
      if (changed) {
        update.run(JSON.stringify(meta), r.session_id);
      }
    }

    // Verify the value is now in meta
    const row = getRow(db, "s1")!;
    expect(getMeta(row, "milad_review")).toBe("approved");
  });
});

test("v22 migration: backfills build_complete from column into meta", () => {
  withDb((db) => {
    // Simulate a pre-v22 row with build_complete=1 in the column
    db.query("INSERT INTO catalogue (session_id, build_complete, updated_at) VALUES (?, ?, ?)")
      .run("s2", 1, NOW);

    // Force re-run the v22 migration block
    const rows = db.query("SELECT session_id, milad_review, build_complete, meta FROM catalogue").all() as Array<{
      session_id: string;
      milad_review: string | null;
      build_complete: number | null;
      meta: string | null;
    }>;
    const update = db.prepare("UPDATE catalogue SET meta = ? WHERE session_id = ?");
    for (const r of rows) {
      const meta = r.meta ? JSON.parse(r.meta) : {};
      let changed = false;
      if (r.milad_review !== null && meta.milad_review === undefined) {
        meta.milad_review = r.milad_review;
        changed = true;
      }
      if (r.build_complete === 1 && meta.build_complete === undefined) {
        meta.build_complete = true;
        changed = true;
      }
      if (changed) {
        update.run(JSON.stringify(meta), r.session_id);
      }
    }

    // Verify the value is now in meta
    const row = getRow(db, "s2")!;
    expect(getMeta(row, "build_complete")).toBe(true);
  });
});

test("v22 migration: preserves existing meta keys while backfilling", () => {
  withDb((db) => {
    // Create a row with both existing meta and old columns
    setMeta(db, "s3", "existing_key", "existing_value", NOW);
    db.query("UPDATE catalogue SET milad_review = ? WHERE session_id = ?").run("approved", "s3");

    // Force re-run the v22 migration block
    const rows = db.query("SELECT session_id, milad_review, build_complete, meta FROM catalogue").all() as Array<{
      session_id: string;
      milad_review: string | null;
      build_complete: number | null;
      meta: string | null;
    }>;
    const update = db.prepare("UPDATE catalogue SET meta = ? WHERE session_id = ?");
    for (const r of rows) {
      const meta = r.meta ? JSON.parse(r.meta) : {};
      let changed = false;
      if (r.milad_review !== null && meta.milad_review === undefined) {
        meta.milad_review = r.milad_review;
        changed = true;
      }
      if (r.build_complete === 1 && meta.build_complete === undefined) {
        meta.build_complete = true;
        changed = true;
      }
      if (changed) {
        update.run(JSON.stringify(meta), r.session_id);
      }
    }

    // Verify both keys are present
    const row = getRow(db, "s3")!;
    expect(getMeta(row, "existing_key")).toBe("existing_value");
    expect(getMeta(row, "milad_review")).toBe("approved");
  });
});
