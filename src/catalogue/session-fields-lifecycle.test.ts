import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOGUE_PATH } from "../paths.ts";
import { openCatalogue } from "./db-schema.ts";
import { sessionFieldsCommand } from "./session-fields-command.ts";

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccs-session-fields-lifecycle-"));
  previousRoot = process.env.CCS_ROOT;
  process.env.CCS_ROOT = root;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.CCS_ROOT;
  else process.env.CCS_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

function lifecycle(): { completed: number; archived: number; saved: number } {
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    return db.query("SELECT completed, archived, saved FROM catalogue WHERE session_id = 's1'").get() as {
      completed: number;
      archived: number;
      saved: number;
    };
  } finally {
    db.close();
  }
}

describe("session-fields lifecycle compatibility", () => {
  test("saved is a supported boolean lifecycle field", () => {
    expect(sessionFieldsCommand(["s1", "--json", JSON.stringify({ saved: true })])).toBe(0);
    expect(lifecycle()).toEqual({ completed: 0, archived: 0, saved: 1 });
  });

  test("archived input remains an alias for Done and never leaves archived=1", () => {
    expect(sessionFieldsCommand(["s1", "--json", JSON.stringify({ archived: true })])).toBe(0);
    expect(lifecycle()).toEqual({ completed: 1, archived: 0, saved: 0 });
  });

  test("completed true clears stale saved, archived, and parked state", () => {
    expect(sessionFieldsCommand(["s1", "--json", JSON.stringify({ saved: true })])).toBe(0);
    const db = openCatalogue(CATALOGUE_PATH());
    db.query("UPDATE catalogue SET saved = 1, archived = 1, parked_task_id = 'task-1' WHERE session_id = 's1'").run();
    db.close();

    expect(sessionFieldsCommand(["s1", "--json", JSON.stringify({ completed: true })])).toBe(0);
    const check = openCatalogue(CATALOGUE_PATH());
    try {
      expect(check.query(
        "SELECT completed, archived, saved, parked_task_id AS parkedTaskId FROM catalogue WHERE session_id = 's1'",
      ).get()).toEqual({ completed: 1, archived: 0, saved: 0, parkedTaskId: null });
    } finally {
      check.close();
    }
  });
});
