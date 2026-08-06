import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "./db-schema.ts";
import { getRow } from "./db-queries.ts";
import { setEnrichment, recordEnrichmentFailure, setCompleted } from "./db-mutations.ts";
import type { Enrichment } from "./enrichment-schema.ts";

const NOW = "2026-07-24T12:00:00.000Z";

const ENRICHMENT: Enrichment = {
  title: "Catalogue v38 enrichment",
  state: "The v38 migration is applied and `ccs enrich` runs. The launchd agent is not installed.",
  history: "Migrated the catalogue to v38 and shipped the enrich command.",
  next: "Install the launchd agent",
  remaining: "then write the sweep tests",
  recommendation: "continue",
  reason: "",
  junk: false,
  cwdCorrect: false,
  suggestedLocation: "repos-ccs",
  suggestedCwd: "",
  atMessages: 412,
  at: NOW,
};

describe("enrichment storage", () => {
  test("round-trips every field through real columns", () => {
    const db = openCatalogue(":memory:");
    setEnrichment(db, "s1", ENRICHMENT, NOW);
    const stored = getRow(db, "s1")?.enrichment;
    expect(stored).toEqual({
      title: ENRICHMENT.title,
      state: ENRICHMENT.state,
      history: ENRICHMENT.history,
      next: ENRICHMENT.next,
      remaining: ENRICHMENT.remaining,
      recommendation: "continue",
      reason: null,
      junk: false,
      cwdCorrect: false,
      suggestedLocation: "repos-ccs",
      // Empty string is stored as NULL so "no suggestion" has one representation, not two.
      suggestedCwd: null,
      legacyShape: false,
      atMessages: 412,
      at: NOW,
      declined: null,
    });
    db.close();
  });

  test("a session that was never enriched reads as null, not a half-built object", () => {
    const db = openCatalogue(":memory:");
    setCompleted(db, "s1", true, NOW);
    expect(getRow(db, "s1")?.enrichment).toBeNull();
    db.close();
  });

  test("full catalogue hydration retains enrichment_at as its ownership boundary", () => {
    const db = openCatalogue(":memory:");
    db.query("INSERT INTO catalogue (session_id, enrichment_state) VALUES ('state-only', 'readable')").run();
    db.query("INSERT INTO catalogue (session_id, enrichment_at) VALUES ('at-only', $at)").run({ $at: NOW });

    expect(getRow(db, "state-only")?.enrichment).toBeNull();
    expect(getRow(db, "at-only")?.enrichment).toMatchObject({
      state: null,
      at: NOW,
      recommendation: null,
      atMessages: null,
    });
    db.close();
  });

  test("booleans survive the integer round-trip", () => {
    const db = openCatalogue(":memory:");
    setEnrichment(db, "s1", { ...ENRICHMENT, junk: true, cwdCorrect: true, suggestedLocation: "" }, NOW);
    const stored = getRow(db, "s1")?.enrichment;
    expect(stored?.junk).toBe(true);
    expect(stored?.cwdCorrect).toBe(true);
    expect(stored?.suggestedLocation).toBeNull();
    db.close();
  });

  test("re-enriching replaces in place rather than accumulating rows", () => {
    const db = openCatalogue(":memory:");
    setEnrichment(db, "s1", ENRICHMENT, NOW);
    setEnrichment(db, "s1", { ...ENRICHMENT, state: "Second pass.", atMessages: 500 }, NOW);
    const count = db.query("SELECT COUNT(*) AS n FROM catalogue WHERE session_id = 's1'").get() as { n: number };
    expect(count.n).toBe(1);
    expect(getRow(db, "s1")?.enrichment?.state).toBe("Second pass.");
    expect(getRow(db, "s1")?.enrichment?.atMessages).toBe(500);
    db.close();
  });

  test("the database refuses a recommendation outside the enum", () => {
    // Defence in depth: the CHECK holds even for a writer that bypasses the zod parser.
    const db = openCatalogue(":memory:");
    setEnrichment(db, "s1", ENRICHMENT, NOW);
    expect(() =>
      db.query("UPDATE catalogue SET enrichment_recommendation = 'delete' WHERE session_id = 's1'").run(),
    ).toThrow();
    db.close();
  });

  test("failures accumulate and a success clears the budget", () => {
    const db = openCatalogue(":memory:");
    recordEnrichmentFailure(db, "s1", NOW);
    recordEnrichmentFailure(db, "s1", NOW);
    expect(getRow(db, "s1")?.enrichmentAttempts).toBe(2);
    // A session that starts working again must get its full retry budget back, or one bad week
    // would permanently disqualify a session that is now perfectly enrichable.
    setEnrichment(db, "s1", ENRICHMENT, NOW);
    expect(getRow(db, "s1")?.enrichmentAttempts).toBe(0);
    db.close();
  });

  test("recording a failure on an unknown session creates its row", () => {
    const db = openCatalogue(":memory:");
    recordEnrichmentFailure(db, "brand-new", NOW);
    expect(getRow(db, "brand-new")?.enrichmentAttempts).toBe(1);
    db.close();
  });
});

describe("enrichment migrations", () => {
  test("upgrades a v37 catalogue in place, preserving existing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccs-enrich-migration-"));
    const path = join(dir, "catalogue.db");
    try {
      // Build a real v37 catalogue through the migrator, then rewind the stamp so the v38 block
      // has to run against a populated database rather than an empty one.
      const first = openCatalogue(path);
      setCompleted(first, "legacy", true, NOW);
      first.close();

      const rewind = new Database(path);
      rewind.exec("PRAGMA user_version = 37;");
      rewind.exec("DROP INDEX IF EXISTS idx_catalogue_enrichment_recommendation;");
      rewind.exec("DROP INDEX IF EXISTS idx_catalogue_enrichment_at;");
      for (const column of [
        "enrichment_summary", "enrichment_outstanding", "enrichment_recommendation",
        "enrichment_reason", "enrichment_junk", "enrichment_cwd_correct",
        "enrichment_suggested_location", "enrichment_suggested_cwd",
        "enrichment_at_messages", "enrichment_at", "enrichment_attempts", "enrichment_title",
        // v40's four. A rewind that left these behind would not be a v37 catalogue, and the
        // upgrade path being tested here would silently skip its own ADD COLUMN guards.
        "enrichment_state", "enrichment_history", "enrichment_next", "enrichment_remaining",
      ]) {
        rewind.exec(`ALTER TABLE catalogue DROP COLUMN ${column};`);
      }
      rewind.close();

      const upgraded = openCatalogue(path);
      expect(upgraded.query("PRAGMA user_version").get()).toEqual({ user_version: 40 });
      expect(getRow(upgraded, "legacy")?.completed).toBe(true);
      expect(getRow(upgraded, "legacy")?.enrichment).toBeNull();
      setEnrichment(upgraded, "legacy", ENRICHMENT, NOW);
      expect(getRow(upgraded, "legacy")?.enrichment?.atMessages).toBe(412);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent when the columns already exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccs-enrich-idempotent-"));
    const path = join(dir, "catalogue.db");
    try {
      openCatalogue(path).close();
      // An older binary can reset user_version, so the v38 block must survive re-running against
      // a catalogue that already has its columns — the same guard every migration here carries.
      const rewind = new Database(path);
      rewind.exec("PRAGMA user_version = 37;");
      rewind.close();

      const reopened = openCatalogue(path);
      expect(reopened.query("PRAGMA user_version").get()).toEqual({ user_version: 40 });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
