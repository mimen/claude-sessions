import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  constructsCatalogueWriter,
  exactAllowlistDifferences,
  importReferences,
  importsModule,
  importsNamedBindingFromModule,
  protectedMutationSql,
} from "./mutation-boundary-scanner.ts";

/** ADR-0068: physical module resolution, not symbol-name matching, enforces catalogue writes. */

const ROOT = new URL("../../", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const SCRIPTS = join(ROOT, "scripts");
const BIN = join(ROOT, "bin");
const DB_SCHEMA = join(SRC, "catalogue", "db-schema.ts");
const DB_MUTATIONS = join(SRC, "catalogue", "db-mutations.ts");
const OLD_DB_BARREL = join(SRC, "catalogue", "db.ts");
const IDENTITIES = join(SRC, "catalogue", "identities.ts");
const IDENTITY_MUTATIONS = new Set(["setIdentityFields"]);

const SANCTIONED_MUTATION_IMPORTERS: Record<string, string> = {
  "src/catalogue/commands.ts": "the command layer, the canonical validated and stamped mutation door",
  "src/catalogue/command.ts": "the natural-language catalogue editor command surface",
  "src/catalogue/session-fields-command.ts": "the atomic multi-field CLI command surface",
  "src/catalogue/historical-detached-child-backfill.ts": "the reviewed exact-manifest transactional backfill",
  "src/resume/new-session.ts": "the spawn primitive writes session birth metadata",
  "src/delegate/command.ts": "the delegated-child launcher reserves causal birth metadata",
  "src/hooks/register.ts": "the SessionStart hook stamps the session heartbeat",
  "src/hooks/worker-stop-command.ts": "the Stop hook stamps the session heartbeat",
  "src/enrich/enrich.ts": "the enrichment worker atomically stores observations and retry failures",
  "scripts/backfill-identity-from-cwd.ts": "the one-time identity-from-cwd maintenance script",
  "scripts/dedup-sessions-per-identity.ts": "the reviewed identity deduplication maintenance script",
};

const SANCTIONED_RAW_SQL_WRITERS: Record<string, string> = {
  "src/catalogue/db-schema.ts": "owns catalogue schema creation and migrations",
  "src/catalogue/db-mutations.ts": "owns raw catalogue row and tag mutations",
  "src/catalogue/commands.ts": "mirrors validated command writes into identity tables",
  "src/catalogue/identities.ts": "owns identity CRUD",
  "src/catalogue/identity-schema.ts": "materializes declared identity schemas",
  "src/catalogue/session-command.ts": "owns the bounded session purge transaction",
  "src/resume/new-session.ts": "atomically links a newly spawned session to its identity",
  "src/state/groupings-db.ts": "owns grouping persistence in the catalogue database",
  "src/state/groupings-migrate.ts": "migrates legacy grouping state into catalogue storage",
  "src/inbox/inbox-db.ts": "owns inbox persistence in the catalogue database",
  "src/sidebar/bench/fixtures.ts": "creates generated catalogue fixtures outside request paths",
  "src/sidebar/bench/benchmark.ts": "mutates generated fixtures to measure changed snapshots and contention",
  "scripts/backfill-identity-from-cwd.ts": "links catalogue rows to recovered identities in reviewed maintenance",
};

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      filesUnder(full, out);
      continue;
    }
    if (/\.(?:ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function bunEntrypointsUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      bunEntrypointsUnder(full, out);
      continue;
    }
    if (readFileSync(full, "utf8").startsWith("#!/usr/bin/env bun\n")) out.push(full);
  }
  return out;
}

function repositoryFiles(): string[] {
  return [...filesUnder(SRC), ...filesUnder(SCRIPTS), ...bunEntrypointsUnder(BIN)];
}

function repoPath(file: string): string {
  return relative(ROOT, file);
}

function isTest(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

test("scanner resolves every supported module spelling to the mutation module", () => {
  const importer = join(SRC, "nested", "deeper", "writer.ts");
  const sources = [
    'import { setMeta } from "../../catalogue/db-mutations.ts";',
    'export { setMeta } from "../../catalogue/db-mutations";',
    'const mutations = await import("../../catalogue/db-mutations.ts");',
    'const mutations = require("../../catalogue/db-mutations.ts");',
    'const { setMeta } = require("../../catalogue/db-mutations.ts");',
  ];
  for (const source of sources) expect(importsModule(source, importer, DB_MUTATIONS)).toBeTrue();
});

test("scanner parses static, export, dynamic, and require module references", () => {
  const references = importReferences(`
    import { a } from "./a.ts";
    export { b } from "./b.ts";
    export * from "./c.ts";
    const d = import("./d.ts");
    const e = require("./e.ts");
  `).map((reference) => reference.specifier);
  expect(references).toEqual(["./a.ts", "./b.ts", "./c.ts", "./d.ts", "./e.ts"]);
});

test("exact allowlists reject both unexpected importers and stale pre-authorizations", () => {
  expect(exactAllowlistDifferences(
    new Set(["src/active.ts", "src/unexpected.ts"]),
    new Set(["src/active.ts", "src/stale.ts"]),
  )).toEqual({ unexpected: ["src/unexpected.ts"], stale: ["src/stale.ts"] });
});

test("SQL scanner catches every catalogue-owned table and dynamic identity tables", () => {
  const catalogueTables = [
    "catalogue",
    "dispositions",
    "epics",
    "groupings",
    "historical_detached_child_backfills",
    "identities",
    "identity_state",
    "identity_pr_agent",
    "inboxes",
    "roles",
    "schema_migrations",
    "session_tags",
  ];
  for (const table of catalogueTables) {
    expect(protectedMutationSql(`db.prepare("UPDATE ${table} SET updated_at = $now")`)).toHaveLength(1);
  }
  expect(protectedMutationSql('const sql = `DELETE FROM session_tags WHERE session_id = ${id}`; db.run(sql);')).toHaveLength(1);
  expect(protectedMutationSql('db.run("UPDATE groupings SET label = ?")')).toHaveLength(1);
  expect(protectedMutationSql('db.run("INSERT INTO inboxes (message) VALUES (?)")')).toHaveLength(1);
  expect(protectedMutationSql('db.exec(`CREATE TABLE IF NOT EXISTS ${schema.tableName} (identity_key TEXT)`)')).toHaveLength(1);
  expect(protectedMutationSql('db.exec(`ALTER TABLE ${schema.tableName} ADD COLUMN value TEXT`)')).toHaveLength(1);
  expect(protectedMutationSql('db.exec(`CREATE INDEX idx ON ${schema.tableName}(value)`)')).toHaveLength(1);
  expect(protectedMutationSql('const sql = "SELECT * FROM catalogue";')).toEqual([]);
  expect(protectedMutationSql('const sql = "UPDATE unrelated SET value = 1";')).toEqual([]);
});

test("sidebar scanner catches aliases, namespace members, and dynamic identity namespaces", () => {
  const sidebarFile = join(SRC, "sidebar", "request.ts");
  const writerTargets = { catalogueSchemaModule: DB_SCHEMA };
  expect(importsNamedBindingFromModule(
    'import { setIdentityFields as setFields } from "../catalogue/identities.ts";',
    sidebarFile,
    IDENTITIES,
    IDENTITY_MUTATIONS,
  )).toBeTrue();
  expect(importsNamedBindingFromModule(
    'const identities = await import("../catalogue/identities.ts"); identities.setIdentityFields(key, fields);',
    sidebarFile,
    IDENTITIES,
    IDENTITY_MUTATIONS,
  )).toBeTrue();
  expect(constructsCatalogueWriter(
    'import { openCatalogue as open } from "../catalogue/db-schema.ts"; open(path);',
    sidebarFile,
    writerTargets,
  )).toBeTrue();
  expect(constructsCatalogueWriter(
    'const schema = await import("../catalogue/db-schema.ts"); schema.openCatalogue(path);',
    sidebarFile,
    writerTargets,
  )).toBeTrue();
  expect(constructsCatalogueWriter(
    'import { Database as Sqlite } from "bun:sqlite"; new Sqlite(path);',
    sidebarFile,
    writerTargets,
  )).toBeTrue();
  expect(constructsCatalogueWriter(
    'import * as sqlite from "bun:sqlite"; new sqlite.Database(path);',
    sidebarFile,
    writerTargets,
  )).toBeTrue();
  expect(constructsCatalogueWriter(
    'import { Database as Sqlite } from "bun:sqlite"; const options = { readonly: true }; new Sqlite(path, options);',
    sidebarFile,
    writerTargets,
  )).toBeFalse();
});

test("repository scan includes Bun TypeScript entrypoints and excludes shell binaries", () => {
  const files = repositoryFiles().map(repoPath);
  expect(files).toContain("bin/ccs");
  expect(files).not.toContain("bin/ccs-claude-shim");
});

test("the deleted catalogue db barrel cannot be imported from source, tests, or scripts", () => {
  const violations = repositoryFiles()
    .filter((file) => importsModule(readFileSync(file, "utf8"), file, OLD_DB_BARREL))
    .map(repoPath);
  expect(violations).toEqual([]);
});

test("actual production mutation importers exactly equal the sanctioned allowlist", () => {
  const actual = new Set<string>();
  for (const file of repositoryFiles()) {
    if (isTest(file)) continue;
    if (importsModule(readFileSync(file, "utf8"), file, DB_MUTATIONS)) actual.add(repoPath(file));
  }
  const differences = exactAllowlistDifferences(actual, new Set(Object.keys(SANCTIONED_MUTATION_IMPORTERS)));
  expect(differences).toEqual({ unexpected: [], stale: [] });
});

test("actual raw catalogue SQL writers exactly equal the sanctioned allowlist", () => {
  const actual = new Set<string>();
  for (const file of repositoryFiles()) {
    if (isTest(file)) continue;
    if (protectedMutationSql(readFileSync(file, "utf8"), file).length > 0) actual.add(repoPath(file));
  }
  const differences = exactAllowlistDifferences(actual, new Set(Object.keys(SANCTIONED_RAW_SQL_WRITERS)));
  expect(differences).toEqual({ unexpected: [], stale: [] });
});

test("sidebar request modules use query-only adapters and never construct a writer", () => {
  const violations: string[] = [];
  for (const file of filesUnder(join(SRC, "sidebar"))) {
    const path = repoPath(file);
    if (isTest(file) || path.startsWith("src/sidebar/bench/")) continue;
    const source = readFileSync(file, "utf8");
    if (importsModule(source, file, DB_MUTATIONS)) violations.push(`${path} imports db-mutations.ts`);
    if (importsNamedBindingFromModule(source, file, IDENTITIES, IDENTITY_MUTATIONS)) {
      violations.push(`${path} imports setIdentityFields directly`);
    }
    if (constructsCatalogueWriter(source, file, { catalogueSchemaModule: DB_SCHEMA })) {
      violations.push(`${path} constructs a catalogue writer`);
    }
    if (protectedMutationSql(source, file).length > 0) violations.push(`${path} contains protected mutation SQL`);
  }
  expect(violations).toEqual([]);
});
