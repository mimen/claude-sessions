import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { messagesSince, readEnrichmentSummaries } from "./enrichment.ts";

/** A catalogue carrying only the columns the reader actually selects. */
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

const FULL = [
  "session_id TEXT PRIMARY KEY",
  "resume_id TEXT",
  "enrichment_summary TEXT",
  "enrichment_reason TEXT",
  "enrichment_recommendation TEXT",
  "enrichment_outstanding TEXT",
  "enrichment_at_messages INTEGER",
];

test("reads every enrichment field and keys it by session id", () => {
  const db = catalogueWith(FULL, [{
    session_id: "s1",
    resume_id: null,
    enrichment_summary: "  Built the sidebar  ",
    enrichment_reason: "tests pass",
    enrichment_recommendation: "open the PR",
    enrichment_outstanding: "screenshots",
    enrichment_at_messages: 120,
  }]);
  const found = readEnrichmentSummaries(db).get("s1");
  expect(found).toEqual({
    summary: "Built the sidebar",
    reason: "tests pass",
    recommendation: "open the PR",
    outstanding: "screenshots",
    atMessages: 120,
  });
});

test("a resumed session finds its summary under either identity", () => {
  const db = catalogueWith(FULL, [{
    session_id: "canonical",
    resume_id: "resumed",
    enrichment_summary: "same record",
    enrichment_at_messages: 5,
  }]);
  const summaries = readEnrichmentSummaries(db);
  expect(summaries.get("canonical")).toBe(summaries.get("resumed")!);
});

test("blank and missing summaries yield no entry rather than an empty string", () => {
  const db = catalogueWith(FULL, [
    { session_id: "blank", enrichment_summary: "   " },
    { session_id: "null", enrichment_summary: null },
  ]);
  expect(readEnrichmentSummaries(db).size).toBe(0);
});

test("blank companion fields read as null, not empty strings", () => {
  const db = catalogueWith(FULL, [{
    session_id: "s1",
    enrichment_summary: "did a thing",
    enrichment_reason: "",
    enrichment_recommendation: "   ",
  }]);
  const found = readEnrichmentSummaries(db).get("s1")!;
  expect(found.reason).toBeNull();
  expect(found.recommendation).toBeNull();
});

test("a catalogue predating the companion columns still yields what it has", () => {
  const db = catalogueWith(
    ["session_id TEXT PRIMARY KEY", "resume_id TEXT", "enrichment_summary TEXT"],
    [{ session_id: "s1", enrichment_summary: "old schema" }],
  );
  const found = readEnrichmentSummaries(db).get("s1")!;
  expect(found.summary).toBe("old schema");
  expect(found.recommendation).toBeNull();
  expect(found.atMessages).toBeNull();
});

test("a catalogue predating enrichment entirely yields nothing", () => {
  const db = catalogueWith(["session_id TEXT PRIMARY KEY"], [{ session_id: "s1" }]);
  expect(readEnrichmentSummaries(db).size).toBe(0);
});

test("an unreadable catalogue costs the caller nothing", () => {
  const db = new Database(":memory:");
  expect(readEnrichmentSummaries(db).size).toBe(0);
});

test("staleness counts messages appended since the summary", () => {
  expect(messagesSince({ atMessages: 100 }, 142)).toBe(42);
  expect(messagesSince({ atMessages: 100 }, 100)).toBe(0);
});

// A summary stamped after the count it is compared against would otherwise report a negative
// staleness, which reads as "the transcript went backwards" rather than "this is current".
test("a summary ahead of the current count reads as current, never negative", () => {
  expect(messagesSince({ atMessages: 200 }, 150)).toBe(0);
});

test("staleness is unknown, not zero, when either count is missing", () => {
  expect(messagesSince({ atMessages: null }, 142)).toBeNull();
  expect(messagesSince({ atMessages: 100 }, null)).toBeNull();
  expect(messagesSince({ atMessages: 100 }, undefined)).toBeNull();
});
