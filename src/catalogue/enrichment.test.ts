import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { messagesSince, readEnrichments } from "./enrichment.ts";

/** A catalogue carrying only the columns a given generation of the schema had. */
function catalogueWith(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE catalogue (${columns.join(", ")})`);
  for (const row of rows) {
    const names = Object.keys(row);
    db.query(
      `INSERT INTO catalogue (${names.join(", ")}) VALUES (${names.map((n) => `$${n}`).join(", ")})`,
    ).run(Object.fromEntries(names.map((n) => [`$${n}`, row[n] as never])));
  }
  return db;
}

const V40 = [
  "session_id TEXT PRIMARY KEY",
  "resume_id TEXT",
  "enrichment_state TEXT",
  "enrichment_summary TEXT",
  "enrichment_history TEXT",
  "enrichment_next TEXT",
  "enrichment_remaining TEXT",
  "enrichment_outstanding TEXT",
  "enrichment_recommendation TEXT",
  "enrichment_reason TEXT",
  "enrichment_junk INTEGER",
  "enrichment_at_messages INTEGER",
  "enrichment_at TEXT",
];

const V39 = [
  "session_id TEXT PRIMARY KEY",
  "resume_id TEXT",
  "enrichment_summary TEXT",
  "enrichment_outstanding TEXT",
  "enrichment_reason TEXT",
  "enrichment_at_messages INTEGER",
];

test("reads a v40 row whole", () => {
  const db = catalogueWith(V40, [{
    session_id: "s1",
    enrichment_state: "  The sidebar renders in the left rail  ",
    enrichment_history: "Built the projection, then the web host",
    enrichment_next: "Wire the suggestion chips",
    enrichment_remaining: "Infinite scroll",
    enrichment_recommendation: "continue",
    enrichment_reason: "",
    enrichment_junk: 0,
    enrichment_at_messages: 120,
    enrichment_at: "2026-07-27T00:00:00.000Z",
  }]);
  expect(readEnrichments(db).get("s1")).toEqual({
    state: "The sidebar renders in the left rail",
    history: "Built the projection, then the web host",
    next: "Wire the suggestion chips",
    remaining: "Infinite scroll",
    recommendation: "continue",
    reason: null,
    junk: false,
    atMessages: 120,
    at: "2026-07-27T00:00:00.000Z",
  });
});

// The split was additive, so most rows in a real catalogue are still v39 shaped. Falling back is
// the normal path, not an edge case.
test("a v39 row falls back to summary and outstanding", () => {
  const db = catalogueWith(V39, [{
    session_id: "s1",
    enrichment_summary: "Legacy prose",
    enrichment_outstanding: "The one open thing",
    enrichment_at_messages: 50,
  }]);
  const found = readEnrichments(db).get("s1")!;
  expect(found.state).toBe("Legacy prose");
  expect(found.next).toBe("The one open thing");
  expect(found.history).toBeNull();
  expect(found.remaining).toBeNull();
});

test("v40 state wins over a legacy summary on the same row", () => {
  const db = catalogueWith(V40, [{
    session_id: "s1",
    enrichment_state: "current",
    enrichment_summary: "stale",
    enrichment_next: "do this",
    enrichment_outstanding: "old open work",
  }]);
  const found = readEnrichments(db).get("s1")!;
  expect(found.state).toBe("current");
  expect(found.next).toBe("do this");
});

test("recommendation is constrained to the shipped vocabulary", () => {
  const db = catalogueWith(V40, [
    { session_id: "ok", enrichment_state: "s", enrichment_recommendation: "archive" },
    { session_id: "bogus", enrichment_state: "s", enrichment_recommendation: "delete" },
    { session_id: "none", enrichment_state: "s", enrichment_recommendation: null },
  ]);
  const found = readEnrichments(db);
  expect(found.get("ok")!.recommendation).toBe("archive");
  // A verb outside the enum reads as no recommendation rather than passing through, so a UI can
  // never be handed an action it has no button for.
  expect(found.get("bogus")!.recommendation).toBeNull();
  expect(found.get("none")!.recommendation).toBeNull();
});

test("junk is a real boolean", () => {
  const db = catalogueWith(V40, [
    { session_id: "junk", enrichment_state: "s", enrichment_junk: 1 },
    { session_id: "kept", enrichment_state: "s", enrichment_junk: 0 },
    { session_id: "unasked", enrichment_state: "s", enrichment_junk: null },
  ]);
  const found = readEnrichments(db);
  expect(found.get("junk")!.junk).toBe(true);
  expect(found.get("kept")!.junk).toBe(false);
  expect(found.get("unasked")!.junk).toBe(false);
});

test("a resumed session finds its enrichment under either identity", () => {
  const db = catalogueWith(V40, [{
    session_id: "canonical",
    resume_id: "resumed",
    enrichment_state: "same record",
  }]);
  const found = readEnrichments(db);
  expect(found.get("canonical")).toBe(found.get("resumed")!);
});

test("blank and missing enrichments yield no entry", () => {
  const db = catalogueWith(V40, [
    { session_id: "blank", enrichment_state: "   " },
    { session_id: "null", enrichment_state: null },
  ]);
  expect(readEnrichments(db).size).toBe(0);
});

// v40 requires `reason` to be EMPTY on continue and complete, so empty has to read as "no reason"
// rather than as an empty string a UI would render as a blank line.
test("an empty reason reads as null", () => {
  const db = catalogueWith(V40, [{
    session_id: "s1",
    enrichment_state: "s",
    enrichment_recommendation: "complete",
    enrichment_reason: "",
  }]);
  expect(readEnrichments(db).get("s1")!.reason).toBeNull();
});

test("a catalogue predating enrichment entirely yields nothing", () => {
  const db = catalogueWith(["session_id TEXT PRIMARY KEY"], [{ session_id: "s1" }]);
  expect(readEnrichments(db).size).toBe(0);
});

test("an unreadable catalogue costs the caller nothing", () => {
  expect(readEnrichments(new Database(":memory:")).size).toBe(0);
});

test("staleness counts messages appended since the enrichment", () => {
  expect(messagesSince({ atMessages: 100 }, 142)).toBe(42);
  expect(messagesSince({ atMessages: 100 }, 100)).toBe(0);
});

test("an enrichment ahead of the current count reads as current, never negative", () => {
  expect(messagesSince({ atMessages: 200 }, 150)).toBe(0);
});

test("staleness is unknown, not zero, when either count is missing", () => {
  expect(messagesSince({ atMessages: null }, 142)).toBeNull();
  expect(messagesSince({ atMessages: 100 }, null)).toBeNull();
  expect(messagesSince({ atMessages: 100 }, undefined)).toBeNull();
});
