import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSidebarReadCache } from "./read-cache.ts";

function createDatabases(root: string): { readonly cataloguePath: string; readonly indexPath: string } {
  const cataloguePath = join(root, "catalogue.sqlite");
  const catalogue = new Database(cataloguePath);
  catalogue.exec(`
    CREATE TABLE catalogue (
      session_id TEXT PRIMARY KEY,
      custom_title TEXT,
      completed INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0
    );
    INSERT INTO catalogue (session_id, custom_title) VALUES ('session-1', 'Before');
  `);
  catalogue.close();

  const indexPath = join(root, "index.sqlite");
  const index = new Database(indexPath);
  index.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      resume_id TEXT,
      cwd TEXT,
      last_ts TEXT,
      models TEXT,
      cost_by_model TEXT,
      is_subagent INTEGER,
      native_title TEXT
    );
    INSERT INTO sessions VALUES (
      'session-1', 'session-1', '/repo', '2026-08-05T00:00:00Z', '[]', '{}', 0, 'Before'
    );
  `);
  index.close();
  return { cataloguePath, indexPath };
}

describe("SidebarReadCache", () => {
  test("a second connection invalidates each durable cache exactly once on the next read", () => {
    const root = mkdtempSync(join(tmpdir(), "sidebar-read-cache-"));
    try {
      const paths = createDatabases(root);
      const cache = createSidebarReadCache(paths.cataloguePath, paths.indexPath);
      expect(cache.readCatalogue().status).toBe("ok");
      expect(cache.readIndex({ limit: 20 })[0]?.title).toBe("Before");
      const before = cache.revision();

      const catalogueWriter = new Database(paths.cataloguePath);
      catalogueWriter.query("UPDATE catalogue SET custom_title = 'After'").run();
      catalogueWriter.close();
      const indexWriter = new Database(paths.indexPath);
      indexWriter.query("UPDATE sessions SET native_title = 'After'").run();
      indexWriter.close();

      const catalogue = cache.readCatalogue();
      expect(catalogue.status).toBe("ok");
      if (catalogue.status === "ok") {
        expect(catalogue.facts.preferredTitles.get("session-1")).toBe("After");
      }
      expect(cache.readIndex({ limit: 20 })[0]?.title).toBe("After");
      const changed = cache.revision();
      expect(changed).toEqual({ catalogue: before.catalogue + 1, index: before.index + 1 });

      cache.readCatalogue();
      cache.readIndex({ limit: 20 });
      expect(cache.revision()).toEqual(changed);
      cache.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
