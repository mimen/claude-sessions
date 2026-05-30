import { test, expect } from "bun:test";
import { openIndex } from "./schema.ts";
import { search, ftsMatchIds } from "./index.ts";

/** Seed one minimal row so the FTS table is non-empty. */
function seeded() {
  const db = openIndex(":memory:");
  db.query(
    `INSERT INTO sessions (
      session_id, host, path, cwd, project_root, project_name,
      fallback_label, msg_count, file_mtime, file_size, skeleton, resume_id
    ) VALUES ('a','h','/p','/c','/c','proj','hello world',1,1,1,'hello world','a')`,
  ).run();
  db.query("INSERT INTO sessions_fts (session_id, title, skeleton) VALUES ('a','hello world','hello world')").run();
  return db;
}

// A malformed FTS query must never throw — search degrades to "no matches".
const NASTY = ['"', '*', 'a AND', 'NEAR(', ')', '^', 'a OR OR b', '""'];

test("search() never throws on malformed queries", () => {
  const db = seeded();
  for (const q of NASTY) {
    expect(() => search(db, q)).not.toThrow();
  }
  // A normal query still works.
  expect(search(db, "hello").map((r) => r.sessionId)).toContain("a");
});

test("ftsMatchIds() never throws on malformed queries", () => {
  const db = seeded();
  for (const q of NASTY) {
    expect(() => ftsMatchIds(db, q)).not.toThrow();
  }
  expect(ftsMatchIds(db, "world").has("a")).toBe(true);
});
