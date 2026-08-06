import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Lifecycle } from "./db-schema.ts";
import type { Recommendation } from "./enrichment-schema.ts";
import {
  hydrateStoredEnrichment,
  messagesSince,
  OPTIONAL_ENRICHMENT_COLUMNS,
  readEnrichments,
  recommendationDisagreement,
} from "./enrichment.ts";

function catalogueWith(columns: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE catalogue (${columns.join(", ")})`);
  for (const row of rows) {
    const names = Object.keys(row);
    db.query(
      `INSERT INTO catalogue (${names.join(", ")}) VALUES (${names.map((name) => `$${name}`).join(", ")})`,
    ).run(Object.fromEntries(names.map((name) => [`$${name}`, row[name] as never])));
  }
  return db;
}

const V40 = [
  "session_id TEXT PRIMARY KEY",
  "resume_id TEXT",
  "enrichment_title TEXT",
  "enrichment_state TEXT",
  "enrichment_summary TEXT",
  "enrichment_history TEXT",
  "enrichment_next TEXT",
  "enrichment_remaining TEXT",
  "enrichment_outstanding TEXT",
  "enrichment_recommendation TEXT",
  "enrichment_reason TEXT",
  "enrichment_junk INTEGER",
  "enrichment_cwd_correct INTEGER",
  "enrichment_suggested_location TEXT",
  "enrichment_suggested_cwd TEXT",
  "enrichment_at_messages INTEGER",
  "enrichment_at TEXT",
  "enrichment_declined TEXT",
];

const V39 = [
  "session_id TEXT PRIMARY KEY",
  "resume_id TEXT",
  "enrichment_title TEXT",
  "enrichment_summary TEXT",
  "enrichment_outstanding TEXT",
  "enrichment_recommendation TEXT",
  "enrichment_reason TEXT",
  "enrichment_at_messages INTEGER",
  "enrichment_at TEXT",
];

describe("canonical enrichment hydration", () => {
  test("the shared optional-column list covers the canonical and compatibility inputs", () => {
    expect(OPTIONAL_ENRICHMENT_COLUMNS).toEqual([
      "enrichment_title", "enrichment_state", "enrichment_summary", "enrichment_history",
      "enrichment_next", "enrichment_remaining", "enrichment_outstanding",
      "enrichment_recommendation", "enrichment_reason", "enrichment_junk",
      "enrichment_cwd_correct", "enrichment_suggested_location", "enrichment_suggested_cwd",
      "enrichment_at_messages", "enrichment_at", "enrichment_declined",
    ]);
  });

  test("hydrates a valid v40 row and normalizes whitespace and optional values", () => {
    expect(hydrateStoredEnrichment({
      enrichment_title: "  Sidebar phase five  ",
      enrichment_state: "  Integrated and green  ",
      enrichment_history: "   ",
      enrichment_next: " Verify snapshots ",
      enrichment_remaining: null,
      enrichment_recommendation: "archive",
      enrichment_reason: " Superseded ",
      enrichment_junk: 1,
      enrichment_cwd_correct: 0,
      enrichment_suggested_location: " worktree ",
      enrichment_suggested_cwd: " /tmp/worktree ",
      enrichment_at_messages: 42,
      enrichment_at: " 2026-08-05T12:00:00.000Z ",
      enrichment_declined: "complete",
    })).toEqual({
      title: "Sidebar phase five",
      state: "Integrated and green",
      history: null,
      next: "Verify snapshots",
      remaining: null,
      recommendation: "archive",
      reason: "Superseded",
      junk: true,
      cwdCorrect: false,
      suggestedLocation: "worktree",
      suggestedCwd: "/tmp/worktree",
      atMessages: 42,
      at: "2026-08-05T12:00:00.000Z",
      legacyShape: false,
      declined: "complete",
    });
  });

  test("hydrates valid v39 prose through canonical fields and marks the legacy shape", () => {
    expect(hydrateStoredEnrichment({
      enrichment_summary: "Legacy state",
      enrichment_outstanding: "Legacy next",
      enrichment_at: "2026-07-01T00:00:00.000Z",
    })).toMatchObject({
      state: "Legacy state",
      next: "Legacy next",
      legacyShape: true,
    });
  });

  test("keeps state without at and at without state literal", () => {
    expect(hydrateStoredEnrichment({ enrichment_state: "state" })).toMatchObject({
      state: "state",
      at: null,
      legacyShape: false,
    });
    expect(hydrateStoredEnrichment({ enrichment_at: "2026-08-05T12:00:00.000Z" })).toMatchObject({
      state: null,
      at: "2026-08-05T12:00:00.000Z",
      legacyShape: false,
    });
  });

  test("runtime-validates recommendation and declined independently", () => {
    expect(hydrateStoredEnrichment({
      enrichment_recommendation: "delete",
      enrichment_declined: "archive",
    })).toMatchObject({ recommendation: null, declined: "archive" });
    expect(hydrateStoredEnrichment({
      enrichment_recommendation: "complete",
      enrichment_declined: "delete",
    })).toMatchObject({ recommendation: "complete", declined: null });
    expect(hydrateStoredEnrichment({})).toMatchObject({ recommendation: null, declined: null });
  });

  test("a missing count is null rather than a synthesized zero", () => {
    expect(hydrateStoredEnrichment({}).atMessages).toBeNull();
  });
});

describe("optional enrichment map adapter", () => {
  test("reads valid v40 and v39 rows", () => {
    const v40 = catalogueWith(V40, [{
      session_id: "v40",
      enrichment_title: "Current",
      enrichment_state: "State",
      enrichment_next: "Next",
      enrichment_recommendation: "continue",
      enrichment_at: "2026-08-05T12:00:00.000Z",
    }]);
    expect(readEnrichments(v40).get("v40")).toMatchObject({
      title: "Current", state: "State", next: "Next", legacyShape: false,
    });

    const v39 = catalogueWith(V39, [{
      session_id: "v39",
      enrichment_summary: "Legacy",
      enrichment_outstanding: "Open",
    }]);
    expect(readEnrichments(v39).get("v39")).toMatchObject({
      state: "Legacy", next: "Open", legacyShape: true,
    });
  });

  test("state is the optional-map presence key even when at is absent", () => {
    const db = catalogueWith(V40, [
      { session_id: "state-only", enrichment_state: "Readable" },
      { session_id: "at-only", enrichment_at: "2026-08-05T12:00:00.000Z" },
    ]);
    expect(readEnrichments(db).has("state-only")).toBeTrue();
    expect(readEnrichments(db).has("at-only")).toBeFalse();
  });

  test("canonical and resume aliases share one record", () => {
    const db = catalogueWith(V40, [{
      session_id: "canonical",
      resume_id: "resume",
      enrichment_state: "same record",
    }]);
    const found = readEnrichments(db);
    expect(found.get("canonical")).toBe(found.get("resume"));
  });

  test("blank rows and pre-enrichment catalogues yield no entry", () => {
    const blank = catalogueWith(V40, [
      { session_id: "blank", enrichment_state: "   " },
      { session_id: "null", enrichment_state: null },
    ]);
    expect(readEnrichments(blank).size).toBe(0);
    expect(readEnrichments(catalogueWith(["session_id TEXT PRIMARY KEY"], [{ session_id: "s" }])).size)
      .toBe(0);
  });

  test("an unreadable catalogue remains fail-open", () => {
    expect(readEnrichments(new Database(":memory:")).size).toBe(0);
  });
});

describe("recommendation disagreement", () => {
  const recommendations: Array<Recommendation | null> = [
    null, "continue", "complete", "archive", "handoff",
  ];
  const lifecycles: Lifecycle[] = ["idle", "parked", "completed", "archived"];

  test("characterizes every recommendation against every catalogue lifecycle", () => {
    for (const recommendation of recommendations) {
      for (const lifecycle of lifecycles) {
        const expected = lifecycle !== "idle" || recommendation === null || recommendation === "continue"
          ? null
          : recommendation === "complete"
          ? "completed"
          : "archived";
        expect(recommendationDisagreement(recommendation, null, lifecycle)).toBe(expected);
      }
    }
  });

  test("same declined verdict is quiet and a different verdict is new information", () => {
    expect(recommendationDisagreement("archive", "archive", "idle")).toBeNull();
    expect(recommendationDisagreement("archive", "complete", "idle")).toBe("archived");
    expect(recommendationDisagreement("complete", "archive", "idle")).toBe("completed");
  });

  test("cross-terminal, handoff-terminal, parked, and junk-archive domain cases stay quiet or map once", () => {
    expect(recommendationDisagreement("complete", null, "archived")).toBeNull();
    expect(recommendationDisagreement("archive", null, "completed")).toBeNull();
    expect(recommendationDisagreement("handoff", null, "archived")).toBeNull();
    expect(recommendationDisagreement("complete", null, "parked")).toBeNull();
    // Junk is presentation metadata; its archive recommendation follows the ordinary domain rule.
    expect(recommendationDisagreement("archive", null, "idle")).toBe("archived");
  });
});

describe("messagesSince", () => {
  test("counts progress, clamps rewinds, and preserves unknown counts", () => {
    expect(messagesSince({ atMessages: 100 }, 142)).toBe(42);
    expect(messagesSince({ atMessages: 200 }, 150)).toBe(0);
    expect(messagesSince({ atMessages: null }, 142)).toBeNull();
    expect(messagesSince({ atMessages: 100 }, null)).toBeNull();
    expect(messagesSince({ atMessages: 100 }, undefined)).toBeNull();
  });
});
