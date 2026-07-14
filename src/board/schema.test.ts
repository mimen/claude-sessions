import { expect, test } from "bun:test";
import { parseBoard } from "./schema.ts";

const validRow = {
  identity: "pr:o/r#1",
  workUnit: { kind: "pr", repo: "o/r", number: 1 },
  sessions: [],
  pills: [],
  description: null,
  alerts: [],
  awaitingFrom: [] as string[],
  lastComposed: "2026-07-14T00:00:00Z",
};

test("parseBoard: accepts a minimal valid board", () => {
  const raw = JSON.stringify({ rows: [validRow] });
  const r = parseBoard(raw);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.rows).toHaveLength(1);
});

test("parseBoard: accepts extra fields (passthrough)", () => {
  const raw = JSON.stringify({
    rows: [validRow],
    // pr-watch-specific top-level extras — must survive validation.
    counts: { open: 5 },
    senseHealth: { ok: true, failed: [] },
    prs: [{ key: "o/r#1", watched: true }],
    ticketedNoPr: [],
  });
  const r = parseBoard(raw);
  expect(r.ok).toBe(true);
});

test("parseBoard: unwraps ADR-0031 state envelope", () => {
  const raw = JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-07-14T00:00:00Z",
    source: "compose-board",
    data: { rows: [validRow] },
  });
  const r = parseBoard(raw);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.rows).toHaveLength(1);
});

test("parseBoard: rejects malformed JSON", () => {
  const r = parseBoard("{not-json");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("is not valid JSON");
});

test("parseBoard: rejects a row missing required fields", () => {
  const raw = JSON.stringify({
    rows: [{ identity: "pr:o/r#1" }],  // missing workUnit, sessions, pills, etc.
  });
  const r = parseBoard(raw);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("failed schema validation");
});

test("parseBoard: rejects an alert with an invalid severity", () => {
  const raw = JSON.stringify({
    rows: [{
      ...validRow,
      alerts: [{ name: "ci-red", severity: "medium", reason: "x", owner: "worker" }],
    }],
  });
  const r = parseBoard(raw);
  expect(r.ok).toBe(false);
});
