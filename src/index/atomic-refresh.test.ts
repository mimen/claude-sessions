import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reindexStore } from "./index.ts";
import { openIndex } from "./schema.ts";

function source(path: string, sessionId: string, cwd: string): void {
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "user",
      sessionId,
      cwd,
      timestamp: "2026-07-22T12:00:00.000Z",
      message: { role: "user", content: "Atomic refresh marker" },
    })}\n`,
  );
}

test("reindexStore rolls back every row when publication fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-index-atomic-"));
  try {
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    const goodPath = join(root, "good.jsonl");
    const badPath = join(root, "bad.jsonl");
    source(goodPath, "good", cwd);
    source(badPath, "bad", cwd);
    const goodStat = statSync(goodPath);
    const badStat = statSync(badPath);

    const db = openIndex(join(root, "index.db"));
    db.query(
      `INSERT INTO sessions (
         session_id, host, path, cwd, project_root, project_name,
         fallback_label, file_mtime, file_size, resume_id
       ) VALUES ('kept', 'host', '/kept', '/kept', '/kept', 'kept', 'Kept', 1, 1, 'kept')`,
    ).run();
    db.exec(`
      CREATE TRIGGER fail_bad_insert
      BEFORE INSERT ON sessions
      WHEN NEW.session_id = 'bad'
      BEGIN
        SELECT RAISE(ABORT, 'forced publication failure');
      END;
    `);

    await expect(
      reindexStore(
        db,
        [
          { path: goodPath, sessionId: "good", sizeBytes: goodStat.size, mtimeMs: goodStat.mtimeMs },
          { path: badPath, sessionId: "bad", sizeBytes: badStat.size, mtimeMs: badStat.mtimeMs },
        ],
        "host",
      ),
    ).rejects.toThrow("forced publication failure");

    expect(db.query("SELECT session_id FROM sessions ORDER BY session_id").all()).toEqual([
      { session_id: "kept" },
    ]);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
