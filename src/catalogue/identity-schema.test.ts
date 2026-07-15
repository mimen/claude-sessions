import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "./db.ts";
import {
  loadIdentitySchema,
  loadAllIdentitySchemas,
  materializeIdentityTable,
  materializeAllIdentityTables,
  roleKindFromWorkUnit,
  tableSlug,
} from "./identity-schema.ts";

/** Build a role folder at <root>/clusters/<c>/roles/<r>/ with the given tomls. */
function makeRole(
  root: string,
  cluster: string,
  role: string,
  files: { roleToml?: string; identitySchema?: string },
): void {
  const roleDir = join(root, "clusters", cluster, "roles", role);
  mkdirSync(roleDir, { recursive: true });
  if (files.roleToml !== undefined) {
    writeFileSync(join(roleDir, "role.toml"), files.roleToml);
  }
  if (files.identitySchema !== undefined) {
    writeFileSync(join(roleDir, "identity-schema.toml"), files.identitySchema);
  }
}

describe("roleKindFromWorkUnit", () => {
  test("'none' → core", () => expect(roleKindFromWorkUnit("none")).toBe("core"));
  test("undefined → core", () => expect(roleKindFromWorkUnit(undefined)).toBe("core"));
  test("'pr' → fleet", () => expect(roleKindFromWorkUnit("pr")).toBe("fleet"));
  test("'issue' → fleet", () => expect(roleKindFromWorkUnit("issue")).toBe("fleet"));
});

describe("tableSlug", () => {
  test("dashes → underscores", () => expect(tableSlug("pr-agent")).toBe("pr_agent"));
  test("no dashes → unchanged", () => expect(tableSlug("concierge")).toBe("concierge"));
  test("multiple dashes", () => expect(tableSlug("review-agent-fast")).toBe("review_agent_fast"));
});

describe("loadIdentitySchema", () => {
  test("returns null for a core role", () => {
    const root = mkdtempSync(join(tmpdir(), "schema-"));
    try {
      makeRole(root, "c", "concierge", { roleToml: 'kind = "loop"\nwork_unit = "none"\n' });
      expect(loadIdentitySchema(join(root, "clusters", "c"), "concierge")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws when a fleet role has no identity-schema.toml", () => {
    const root = mkdtempSync(join(tmpdir(), "schema-"));
    try {
      makeRole(root, "c", "pr-agent", { roleToml: 'kind = "session"\nwork_unit = "pr"\n' });
      expect(() => loadIdentitySchema(join(root, "clusters", "c"), "pr-agent")).toThrow(
        /missing identity-schema\.toml/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses a full pr-agent schema", () => {
    const root = mkdtempSync(join(tmpdir(), "schema-"));
    try {
      makeRole(root, "c", "pr-agent", {
        roleToml: 'kind = "session"\nwork_unit = "pr"\n',
        identitySchema: `
[columns]
pr_repo   = { type = "text" }
pr_number = { type = "integer", indexed = true }
gus_work  = { type = "text" }

[indexes]
pr_lookup = ["pr_repo", "pr_number"]

[display]
primary  = ["pr_repo", "pr_number"]
subtitle = ["pr_state"]
short    = "pr_number"
`.trim(),
      });
      const schema = loadIdentitySchema(join(root, "clusters", "c"), "pr-agent")!;
      expect(schema.role).toBe("pr-agent");
      expect(schema.tableName).toBe("identity_pr_agent");
      expect(schema.columns.pr_repo!.type).toBe("text");
      expect(schema.columns.pr_number!.indexed).toBe(true);
      expect(schema.compositeIndexes.pr_lookup).toEqual(["pr_repo", "pr_number"]);
      expect(schema.displayPrimary).toEqual(["pr_repo", "pr_number"]);
      expect(schema.displayShort).toBe("pr_number");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid column names", () => {
    const root = mkdtempSync(join(tmpdir(), "schema-"));
    try {
      makeRole(root, "c", "pr-agent", {
        roleToml: 'kind = "session"\nwork_unit = "pr"\n',
        identitySchema: `[columns]\nprRepo = { type = "text" }\n`, // camelCase not allowed
      });
      expect(() => loadIdentitySchema(join(root, "clusters", "c"), "pr-agent")).toThrow(
        /lowercase snake_case/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid column types", () => {
    const root = mkdtempSync(join(tmpdir(), "schema-"));
    try {
      makeRole(root, "c", "pr-agent", {
        roleToml: 'kind = "session"\nwork_unit = "pr"\n',
        identitySchema: `[columns]\nfoo = { type = "date" }\n`,
      });
      expect(() => loadIdentitySchema(join(root, "clusters", "c"), "pr-agent")).toThrow(/invalid type/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a composite index that references an unknown column", () => {
    const root = mkdtempSync(join(tmpdir(), "schema-"));
    try {
      makeRole(root, "c", "pr-agent", {
        roleToml: 'kind = "session"\nwork_unit = "pr"\n',
        identitySchema: `
[columns]
pr_repo = { type = "text" }
[indexes]
bad = ["pr_repo", "nonexistent"]
`.trim(),
      });
      expect(() => loadIdentitySchema(join(root, "clusters", "c"), "pr-agent")).toThrow(
        /unknown column 'nonexistent'/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("materializeIdentityTable", () => {
  test("creates the table + columns + indexes fresh", () => {
    const db = openCatalogue(":memory:");
    const schema = {
      role: "pr-agent",
      tableName: "identity_pr_agent",
      columns: {
        pr_repo: { type: "text" as const },
        pr_number: { type: "integer" as const, indexed: true },
      },
      compositeIndexes: { pr_lookup: ["pr_repo", "pr_number"] },
      migrations: [],
    };
    materializeIdentityTable(db, schema);
    const cols = (db.query("PRAGMA table_info(identity_pr_agent)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(expect.arrayContaining(["identity_key", "pr_repo", "pr_number", "updated_at"]));

    const idx = (db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='identity_pr_agent'")
      .all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["idx_identity_pr_agent_pr_number", "idx_identity_pr_agent_pr_lookup"]));
  });

  test("is idempotent (running twice does nothing on the second pass)", () => {
    const db = openCatalogue(":memory:");
    const schema = {
      role: "pr-agent",
      tableName: "identity_pr_agent",
      columns: { pr_repo: { type: "text" as const } },
      compositeIndexes: {},
      migrations: [],
    };
    materializeIdentityTable(db, schema);
    materializeIdentityTable(db, schema); // should not throw
    const cols = (db.query("PRAGMA table_info(identity_pr_agent)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols.filter((c) => c === "pr_repo").length).toBe(1);
  });

  test("adds new columns without touching existing data", () => {
    const db = openCatalogue(":memory:");
    materializeIdentityTable(db, {
      role: "pr-agent",
      tableName: "identity_pr_agent",
      columns: { pr_repo: { type: "text" as const } },
      compositeIndexes: {},
      migrations: [],
    });
    db.exec(`INSERT INTO identity_pr_agent (identity_key, pr_repo) VALUES ('k1', 'owner/repo')`);
    materializeIdentityTable(db, {
      role: "pr-agent",
      tableName: "identity_pr_agent",
      columns: {
        pr_repo: { type: "text" as const },
        pr_number: { type: "integer" as const }, // new column
      },
      compositeIndexes: {},
      migrations: [],
    });
    const row = db.query("SELECT pr_repo, pr_number FROM identity_pr_agent WHERE identity_key='k1'").get() as {
      pr_repo: string;
      pr_number: number | null;
    };
    expect(row.pr_repo).toBe("owner/repo");
    expect(row.pr_number).toBeNull();
  });

  test("runs a [migrations] block once and records its hash", () => {
    const db = openCatalogue(":memory:");
    const schema = {
      role: "pr-agent",
      tableName: "identity_pr_agent",
      columns: { pr_repo: { type: "text" as const } },
      compositeIndexes: {},
      migrations: [
        { hash: "abc123", sql: "ALTER TABLE identity_pr_agent ADD COLUMN legacy_notes TEXT", description: "backfill" },
      ],
    };
    materializeIdentityTable(db, schema);
    materializeIdentityTable(db, schema); // should not re-apply
    const cols = (db.query("PRAGMA table_info(identity_pr_agent)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("legacy_notes");
    const applied = db
      .query("SELECT migration_hash FROM schema_migrations WHERE role = 'pr-agent'")
      .all() as { migration_hash: string }[];
    expect(applied.length).toBe(1);
    expect(applied[0]!.migration_hash).toBe("abc123");
  });
});

describe("loadAllIdentitySchemas", () => {
  test("finds every fleet role, skips core", () => {
    const root = mkdtempSync(join(tmpdir(), "schema-"));
    try {
      makeRole(root, "pr-watch", "concierge", { roleToml: 'kind = "loop"\nwork_unit = "none"\n' });
      makeRole(root, "pr-watch", "pr-agent", {
        roleToml: 'kind = "session"\nwork_unit = "pr"\n',
        identitySchema: `[columns]\npr_repo = { type = "text" }\n`,
      });
      makeRole(root, "issue-watch", "issue-agent", {
        roleToml: 'kind = "session"\nwork_unit = "issue"\n',
        identitySchema: `[columns]\nissue_id = { type = "integer" }\n`,
      });
      const schemas = loadAllIdentitySchemas(root);
      const roles = schemas.map((s) => s.role).sort();
      expect(roles).toEqual(["issue-agent", "pr-agent"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("materializeAllIdentityTables creates every fleet role's table", () => {
    const root = mkdtempSync(join(tmpdir(), "schema-"));
    try {
      makeRole(root, "pr-watch", "pr-agent", {
        roleToml: 'kind = "session"\nwork_unit = "pr"\n',
        identitySchema: `[columns]\npr_repo = { type = "text" }\n`,
      });
      const db = openCatalogue(":memory:");
      materializeAllIdentityTables(db, root);
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]).map((r) => r.name);
      expect(tables).toContain("identity_pr_agent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
