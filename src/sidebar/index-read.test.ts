import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIndexReadOnly } from "./index-read.ts";

function createIndex(path: string): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        resume_id TEXT,
        cwd TEXT,
        last_ts TEXT,
        models TEXT,
        cost_by_model TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0,
        native_title TEXT,
        codex_title TEXT,
        fallback_label TEXT
      );
    `);
    const insert = db.query(
      `INSERT INTO sessions
         (session_id, resume_id, cwd, last_ts, models, cost_by_model, native_title)
       VALUES ($sessionId, $resumeId, '/repo', $lastTs, '["gpt-5.6-sol"]', '{}', $title)`,
    );
    insert.run({
      $sessionId: "older-file",
      $resumeId: "older-resume",
      $lastTs: "2026-07-24T20:00:00.000Z",
      $title: "Older",
    });
    insert.run({
      $sessionId: "newer-file",
      $resumeId: "newer-resume",
      $lastTs: "2026-07-24T22:00:00.000Z",
      $title: "Newer",
    });
    insert.run({
      $sessionId: "unrequested",
      $resumeId: "unrequested",
      $lastTs: "2026-07-24T23:00:00.000Z",
      $title: "Unrequested",
    });
  } finally {
    db.close();
  }
}

test("reads lifecycle history by canonical or resume id, newest first and capped", () => {
  const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-index-"));
  const dbPath = join(directory, "index.db");
  try {
    createIndex(dbPath);

    const rows = readIndexReadOnly(dbPath, {
      limit: 1,
      sessionIds: ["older-file", "newer-resume"],
    });

    expect(rows.map((row) => row.sessionId)).toEqual(["newer-file"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
