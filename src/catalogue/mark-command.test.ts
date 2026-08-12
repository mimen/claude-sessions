import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOGUE_PATH } from "../paths.ts";
import { mark } from "./commands.ts";
import { openCatalogue } from "./db-schema.ts";

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccs-mark-lifecycle-"));
  previousRoot = process.env.CCS_ROOT;
  process.env.CCS_ROOT = root;
  mkdirSync(join(root, "cache"), { recursive: true });
  const db = openCatalogue(CATALOGUE_PATH());
  db.query(
    "INSERT INTO catalogue (session_id, saved, archived, parked_task_id, updated_at) VALUES ('s1', 1, 1, 'task-1', 'now')",
  ).run();
  db.close();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.CCS_ROOT;
  else process.env.CCS_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
});

describe("ccs mark lifecycle normalization", () => {
  test("archive is a compatibility alias for Done and clears conflicting lifecycle state", () => {
    expect(mark("s1", ["--archived"])).toBe(0);
    const db = openCatalogue(CATALOGUE_PATH());
    try {
      expect(db.query(
        "SELECT completed, archived, saved, parked_task_id AS parkedTaskId FROM catalogue WHERE session_id = 's1'",
      ).get()).toEqual({ completed: 1, archived: 0, saved: 0, parkedTaskId: null });
    } finally {
      db.close();
    }
  });
});
