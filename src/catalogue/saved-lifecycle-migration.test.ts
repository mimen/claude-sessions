import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRow } from "./db-queries.ts";
import { openCatalogue } from "./db-schema.ts";
import { getIdentity, mintIdentity } from "./identities.ts";

describe("Saved lifecycle migration", () => {
  test("folds existing archived work into Done and starts Saved empty", () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-saved-lifecycle-"));
    const path = join(directory, "catalogue.db");
    const identityKey = "sidebar:worker:legacy-archive";
    try {
      const setup = openCatalogue(path, { materialize: false });
      mintIdentity(setup, identityKey, { cluster: "sidebar", role: "worker" }, "2026-08-11T00:00:00Z");
      setup.query(
        "INSERT INTO catalogue (session_id, identity_key, archived) VALUES ('legacy', $identityKey, 1)",
      ).run({ $identityKey: identityKey });
      setup.query(
        "UPDATE identities SET archived = 1 WHERE identity_key = $identityKey",
      ).run({ $identityKey: identityKey });
      setup.close();

      const legacy = new Database(path);
      legacy.exec(`
        DROP TABLE lifecycle_schema_migrations;
        ALTER TABLE catalogue DROP COLUMN saved;
        ALTER TABLE identities DROP COLUMN saved;
        PRAGMA user_version = 40;
      `);
      legacy.close();

      const migrated = openCatalogue(path, { materialize: false });
      try {
        expect(getRow(migrated, "legacy")).toMatchObject({
          completed: true,
          archived: false,
          saved: false,
        });
        expect(getIdentity(migrated, identityKey)).toMatchObject({
          completed: true,
          archived: false,
          saved: false,
        });
        expect(migrated.query(
          "SELECT version FROM lifecycle_schema_migrations",
        ).all()).toEqual([{ version: 1 }]);
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
