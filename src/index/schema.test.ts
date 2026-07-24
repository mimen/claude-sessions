import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex, SCHEMA_VERSION } from "./schema.ts";

test("v7 upgrades add catalogue authority state without dropping indexed sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-index-v7-upgrade-"));
  const path = join(root, "index.db");
  try {
    const old = openIndex(path);
    old.query(
      `INSERT INTO sessions (
         session_id, host, path, cwd, project_root, project_name,
         fallback_label, file_mtime, file_size, resume_id
       ) VALUES ('kept', 'host', '/source', '/cwd', '/cwd', 'cwd', 'Kept', 1, 1, 'kept')`,
    ).run();
    old.exec("DROP TABLE catalogue_hidden_sessions;");
    old.exec("DROP TABLE catalogue_source_status;");
    old.exec("PRAGMA user_version = 7;");
    old.close();

    const upgraded = openIndex(path);
    expect((upgraded.query("PRAGMA user_version").get() as { user_version: number }).user_version)
      .toBe(SCHEMA_VERSION);
    expect(upgraded.query("SELECT session_id FROM sessions WHERE session_id = 'kept'").get())
      .toEqual({ session_id: "kept" });
    expect(upgraded.query("SELECT generation FROM catalogue_source_status WHERE singleton = 1").get())
      .toEqual({ generation: 0 });
    expect(upgraded.query("SELECT COUNT(*) AS count FROM catalogue_hidden_sessions").get())
      .toEqual({ count: 0 });
    upgraded.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
