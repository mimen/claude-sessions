import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFieldsCommand } from "./session-fields-command.ts";
import { openCatalogue, getRow } from "./db.ts";
import { CATALOGUE_PATH } from "../paths.ts";

/**
 * `ccs session-fields ... enrichment` is the seam an EXTERNAL writer uses — a Go TUI, a cluster
 * sensor, anything outside this process. The in-process `ccs enrich` path calls `setEnrichment`
 * directly; this exists so a second implementation never needs to open the catalogue itself.
 */

let dir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccs-session-fields-enrich-"));
  previousRoot = process.env.CCS_ROOT;
  process.env.CCS_ROOT = dir;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.CCS_ROOT;
  else process.env.CCS_ROOT = previousRoot;
  rmSync(dir, { recursive: true, force: true });
});

const VALID = {
  summary: "Shipped the enrichment sweep.",
  outstanding: "",
  recommendation: "complete",
  reason: "The feature landed and tests pass.",
  junk: false,
  cwdCorrect: true,
  suggestedLocation: "",
  suggestedCwd: "",
  atMessages: 42,
};

function run(payload: unknown, extra: string[] = []): number {
  return sessionFieldsCommand(["s1", "--json", JSON.stringify({ enrichment: payload }), ...extra]);
}

function stored() {
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    return getRow(db, "s1")?.enrichment ?? null;
  } finally {
    db.close();
  }
}

describe("session-fields enrichment", () => {
  test("writes a valid enrichment when a sensor is named", () => {
    expect(run(VALID, ["--sensor", "enrichment"])).toBe(0);
    const enrichment = stored();
    expect(enrichment?.recommendation).toBe("complete");
    expect(enrichment?.atMessages).toBe(42);
    // `at` defaults to now, so a writer persisting immediately need not carry a timestamp.
    expect(enrichment?.at).toBeTruthy();
  });

  test("refuses an unsensored write", () => {
    // Same guard as `stage` (ADR-0079). Enrichment is an OBSERVATION of a session; a worker must
    // not be able to write its own flattering summary and recommendation about itself.
    expect(run(VALID)).toBe(2);
    expect(stored()).toBeNull();
  });

  test("refuses a recommendation outside the enum", () => {
    expect(run({ ...VALID, recommendation: "delete" }, ["--sensor", "x"])).toBe(1);
    expect(stored()).toBeNull();
  });

  test("refuses an enrichment missing its message stamp", () => {
    // Without atMessages the summary can never be known to be stale, which defeats the cadence.
    const { atMessages, ...withoutStamp } = VALID;
    expect(run(withoutStamp, ["--sensor", "x"])).toBe(1);
    expect(stored()).toBeNull();
  });

  test("refuses an incoherent cwd judgement", () => {
    expect(run(
      { ...VALID, cwdCorrect: true, suggestedCwd: "/somewhere/else" },
      ["--sensor", "x"],
    )).toBe(1);
    expect(stored()).toBeNull();
  });

  test("refuses a location key this machine does not know", () => {
    expect(run(
      { ...VALID, cwdCorrect: false, suggestedLocation: "not-a-real-location" },
      ["--sensor", "x"],
    )).toBe(1);
    expect(stored()).toBeNull();
  });

  test("accepts a free-text cwd when no registry is present", () => {
    // CCS_ROOT points at an empty temp dir, so there is no locations.toml — the escape hatch has
    // to keep working on a machine the router has not reached.
    expect(run(
      { ...VALID, cwdCorrect: false, suggestedCwd: "/Users/mimen/Programming/Repos/new-thing" },
      ["--sensor", "x"],
    )).toBe(0);
    expect(stored()?.suggestedCwd).toBe("/Users/mimen/Programming/Repos/new-thing");
  });

  test("writes alongside other fields in one atomic call", () => {
    const code = sessionFieldsCommand([
      "s1",
      "--json", JSON.stringify({ enrichment: VALID, completed: true }),
      "--sensor", "enrichment",
    ]);
    expect(code).toBe(0);
    const db = openCatalogue(CATALOGUE_PATH());
    try {
      const row = getRow(db, "s1");
      expect(row?.completed).toBe(true);
      expect(row?.enrichment?.summary).toBe("Shipped the enrichment sweep.");
    } finally {
      db.close();
    }
  });
});
