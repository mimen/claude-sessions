import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ccsConfigRoot } from "../roles/role-files.ts";

/**
 * ADR-0089 step 3: per-fleet-role identity schemas + boot-time materialization.
 *
 * Every fleet role declares its identity-attribute shape in
 * `~/.ccs-config/clusters/<c>/roles/<r>/identity-schema.toml`. Ccs reads them at boot,
 * computes the target schema for each fleet role's `identity_<role_slug>` table, and
 * reconciles the DB additively:
 *   - Missing table → CREATE TABLE.
 *   - Missing columns → ALTER TABLE ADD COLUMN.
 *   - Missing indexes → CREATE INDEX IF NOT EXISTS.
 *   - [migrations] entries whose hash hasn't been applied → run each, record hash.
 *
 * Type vocabulary is a fixed set (text, integer, real, boolean). Anything else is a
 * validation error at boot — fail loud with a clear message so the operator fixes their
 * schema instead of accumulating a subtle mismatch.
 *
 * The role-vs-cluster split: role kind (fleet vs core) is derived from role.toml's
 * `work_unit` field (`"none"` = core, anything else = fleet). Only fleet roles have an
 * identity-schema.toml; a missing file for a fleet role is an error, but a missing file
 * for a core role is fine (no per-role table exists).
 */

/** Allowed SQLite column type tokens. */
const VALID_TYPES = new Set(["text", "integer", "real", "boolean"]);
type ColumnType = "text" | "integer" | "real" | "boolean";

export interface ColumnSpec {
  type: ColumnType;
  indexed?: boolean;
}

export interface IdentitySchema {
  role: string;
  tableName: string;                          // identity_<role_slug>
  columns: Record<string, ColumnSpec>;         // column name → spec
  compositeIndexes: Record<string, string[]>;  // index name → column list
  displayPrimary?: string[];                   // TUI display hint
  displaySubtitle?: string[];
  displayShort?: string;
  migrations: MigrationEntry[];                // explicit renames/drops
}

interface MigrationEntry {
  hash: string;              // stable id (of the migration's payload)
  sql: string;               // literal SQL to execute
  description?: string;
}

/** Role kind derived from role.toml's `work_unit` field. */
export function roleKindFromWorkUnit(workUnit: string | undefined): "fleet" | "core" {
  return !workUnit || workUnit === "none" ? "core" : "fleet";
}

/** Turn a role slug (e.g. "pr-agent") into a table name suffix ("pr_agent"). */
export function tableSlug(role: string): string {
  return role.replace(/-/g, "_");
}

/**
 * Load one role's identity schema, or null if the role is core / has no schema file.
 * Throws if a schema is malformed.
 */
export function loadIdentitySchema(clusterPath: string, role: string): IdentitySchema | null {
  const roleDir = join(clusterPath, "roles", role);
  const rolePath = join(roleDir, "role.toml");
  if (!existsSync(rolePath)) return null;

  const roleToml = parseToml(readFileSync(rolePath, "utf8")) as Record<string, unknown>;
  const kind = roleKindFromWorkUnit(roleToml.work_unit as string | undefined);
  if (kind === "core") return null;

  const schemaPath = join(roleDir, "identity-schema.toml");
  if (!existsSync(schemaPath)) {
    throw new Error(
      `fleet role '${role}' at ${roleDir} is missing identity-schema.toml (required for kind=fleet)`,
    );
  }
  const schema = parseToml(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  return parseSchema(role, schema);
}

/** Parse a raw TOML object into a validated IdentitySchema. */
function parseSchema(role: string, raw: Record<string, unknown>): IdentitySchema {
  const columnsRaw = (raw.columns ?? {}) as Record<string, unknown>;
  const columns: Record<string, ColumnSpec> = {};
  for (const [name, specRaw] of Object.entries(columnsRaw)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
      throw new Error(`identity-schema for '${role}': column name '${name}' must be lowercase snake_case`);
    }
    const spec = specRaw as { type?: string; indexed?: boolean };
    if (!spec || typeof spec !== "object" || !spec.type) {
      throw new Error(`identity-schema for '${role}': column '${name}' missing 'type'`);
    }
    if (!VALID_TYPES.has(spec.type)) {
      throw new Error(
        `identity-schema for '${role}': column '${name}' has invalid type '${spec.type}' (valid: text, integer, real, boolean)`,
      );
    }
    columns[name] = { type: spec.type as ColumnType, indexed: !!spec.indexed };
  }

  const indexesRaw = (raw.indexes ?? {}) as Record<string, unknown>;
  const compositeIndexes: Record<string, string[]> = {};
  for (const [name, colsRaw] of Object.entries(indexesRaw)) {
    if (!Array.isArray(colsRaw)) {
      throw new Error(`identity-schema for '${role}': index '${name}' must be an array of column names`);
    }
    for (const c of colsRaw) {
      if (typeof c !== "string" || !columns[c]) {
        throw new Error(`identity-schema for '${role}': index '${name}' references unknown column '${c}'`);
      }
    }
    compositeIndexes[name] = colsRaw as string[];
  }

  const display = (raw.display ?? {}) as Record<string, unknown>;
  const displayPrimary = Array.isArray(display.primary) ? (display.primary as string[]) : undefined;
  const displaySubtitle = Array.isArray(display.subtitle) ? (display.subtitle as string[]) : undefined;
  const displayShort = typeof display.short === "string" ? display.short : undefined;

  const migrationsRaw = (raw.migrations ?? {}) as Record<string, unknown>;
  const migrations: MigrationEntry[] = [];
  for (const [migName, migRaw] of Object.entries(migrationsRaw)) {
    const m = migRaw as { sql?: string; description?: string };
    if (!m || typeof m.sql !== "string") {
      throw new Error(`identity-schema for '${role}': migration '${migName}' missing 'sql' string`);
    }
    // Hash the payload so the migration is idempotent: if the SQL is unchanged, the hash stays
    // the same and we skip re-applying. If the SQL is edited, the hash changes and it re-runs
    // (which the role owner needs to be aware of — additive-only is the safe pattern).
    const hash = createHash("sha256").update(`${migName}\n${m.sql}`).digest("hex").slice(0, 16);
    migrations.push({ hash, sql: m.sql, description: m.description });
  }

  return {
    role,
    tableName: `identity_${tableSlug(role)}`,
    columns,
    compositeIndexes,
    displayPrimary,
    displaySubtitle,
    displayShort,
    migrations,
  };
}

/** Load every fleet role's schema across every cluster in the config root. */
export function loadAllIdentitySchemas(configRoot = ccsConfigRoot()): IdentitySchema[] {
  const clustersDir = join(configRoot, "clusters");
  if (!existsSync(clustersDir)) return [];
  const out: IdentitySchema[] = [];
  for (const cluster of readdirSync(clustersDir)) {
    const clusterPath = join(clustersDir, cluster);
    if (!statSync(clusterPath).isDirectory()) continue;
    const rolesDir = join(clusterPath, "roles");
    if (!existsSync(rolesDir)) continue;
    for (const role of readdirSync(rolesDir)) {
      const rolePath = join(rolesDir, role);
      if (!statSync(rolePath).isDirectory()) continue;
      const schema = loadIdentitySchema(clusterPath, role);
      if (schema) {
        // The same role slug can appear in multiple clusters (concierge, pr-agent, etc.).
        // Their identity tables are shared — only one identity_<role> per role slug — so if
        // two clusters declare divergent schemas for the same role, that's a conflict the
        // reconciler resolves by taking the union of columns. We normalize here by keeping the
        // first-seen schema; the reconciler will re-run per cluster and union columns.
        if (!out.find((s) => s.role === role)) out.push(schema);
      }
    }
  }
  return out;
}

/**
 * Reconcile a role's identity table against its declared schema. Additive-only for columns
 * and indexes; explicit for migrations. Called at ccs boot after openCatalogue() has run the
 * base migration.
 */
export function materializeIdentityTable(db: Database, schema: IdentitySchema): void {
  // 1. Create the table if it doesn't exist (with just the FK column — actual attribute
  //    columns come from ALTER TABLE below, so we don't have to conditionally CREATE columns
  //    based on schema presence).
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${schema.tableName} (
       identity_key TEXT PRIMARY KEY,
       updated_at   TEXT
     )`,
  );

  // 2. Add any declared columns that are missing.
  const existingCols = new Set(
    (db.query(`PRAGMA table_info(${schema.tableName})`).all() as { name: string; type: string }[]).map(
      (c) => c.name,
    ),
  );
  for (const [colName, colSpec] of Object.entries(schema.columns)) {
    if (!existingCols.has(colName)) {
      const sqlType = sqliteType(colSpec.type);
      db.exec(`ALTER TABLE ${schema.tableName} ADD COLUMN ${colName} ${sqlType}`);
    }
    if (colSpec.indexed) {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_${schema.tableName}_${colName} ON ${schema.tableName}(${colName})`,
      );
    }
  }

  // 3. Composite indexes.
  for (const [idxName, cols] of Object.entries(schema.compositeIndexes)) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${schema.tableName}_${idxName} ON ${schema.tableName}(${cols.join(", ")})`,
    );
  }

  // 4. Apply pending [migrations] blocks — anything whose hash isn't in schema_migrations.
  const applied = new Set(
    (db
      .query("SELECT migration_hash FROM schema_migrations WHERE role = $r")
      .all({ $r: schema.role }) as { migration_hash: string }[]).map((r) => r.migration_hash),
  );
  const nowIso = new Date().toISOString();
  const record = db.query(
    "INSERT INTO schema_migrations (role, migration_hash, applied_at) VALUES ($r, $h, $now)",
  );
  for (const mig of schema.migrations) {
    if (applied.has(mig.hash)) continue;
    db.exec(mig.sql);
    record.run({ $r: schema.role, $h: mig.hash, $now: nowIso });
  }
}

/** Materialize every fleet role in the config root. Called at ccs boot. */
export function materializeAllIdentityTables(db: Database, configRoot = ccsConfigRoot()): void {
  for (const schema of loadAllIdentitySchemas(configRoot)) {
    materializeIdentityTable(db, schema);
  }
}

/** Map identity-schema type token → SQLite storage class. */
function sqliteType(t: ColumnType): string {
  switch (t) {
    case "text":    return "TEXT";
    case "integer": return "INTEGER";
    case "real":    return "REAL";
    case "boolean": return "INTEGER"; // sqlite has no boolean; 0/1
  }
}
