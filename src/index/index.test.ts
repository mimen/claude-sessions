import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reindexStore, sessionById } from "./index.ts";
import { openIndex } from "./schema.ts";

test("models round-trip through the session index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-index-"));
  const path = join(dir, "session.jsonl");
  const transcript = [
    { type: "user", cwd: "/repo", message: { role: "user", content: "hi" } },
    { type: "assistant", message: { model: "gpt-5.6-sol", content: "hello" } },
    { type: "assistant", message: { model: "claude-opus-4-8", content: "again" } },
  ];
  writeFileSync(path, transcript.map((line) => JSON.stringify(line)).join("\n") + "\n");

  const db = openIndex(":memory:");
  try {
    await reindexStore(
      db,
      [{ path, sessionId: "session", sizeBytes: 123, mtimeMs: 456 }],
      "test-host",
    );

    expect(sessionById(db, "session")?.models).toEqual([
      "claude-opus-4-8",
      "gpt-5.6-sol",
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt models cell maps to an empty model history", () => {
  const db = openIndex(":memory:");
  try {
    db.query(
      `INSERT INTO sessions (
        session_id, host, path, project_root, project_name, fallback_label,
        file_mtime, file_size, resume_id, models
      ) VALUES ('session', 'host', '/path', '/repo', 'repo', 'title', 1, 1, 'session', 'bad json')`,
    ).run();

    expect(sessionById(db, "session")?.models).toEqual([]);
  } finally {
    db.close();
  }
});
