import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ADR-0068: imports of the physical catalogue mutation module are the enforced mutation boundary.
 * Query/schema imports are unrestricted; direct writers remain bounded and auditable here.
 */

const ROOT = new URL("../../", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const SCRIPTS = join(ROOT, "scripts");

const SANCTIONED_MUTATION_IMPORTERS: Record<string, string> = {
  "src/catalogue/commands.ts": "the command layer, the canonical validated and stamped mutation door",
  "src/catalogue/command.ts": "the natural-language catalogue editor command surface",
  "src/catalogue/session-fields-command.ts": "the atomic multi-field CLI command surface",
  "src/catalogue/historical-detached-child-backfill.ts": "the reviewed exact-manifest transactional backfill",
  "src/resume/new-session.ts": "the spawn primitive writes session birth metadata",
  "src/delegate/command.ts": "the delegated-child launcher reserves causal birth metadata",
  "src/roles/materialize.ts": "role materialization stamps the session heartbeat",
  "src/hooks/register.ts": "the SessionStart hook stamps the session heartbeat",
  "src/hooks/worker-stop-command.ts": "the Stop hook stamps the session heartbeat",
  "src/enrich/enrich.ts": "the enrichment worker atomically stores observations and retry failures",
  "src/tui/App.tsx": "the TUI applies direct interactive user actions",
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
  "src/catalogue-service/authority.ts": "owns authoritative catalogue-service transactions",
  "src/resume/new-session.ts": "atomically links a newly spawned session to its identity",
  "src/state/groupings-db.ts": "owns grouping persistence in the catalogue database",
  "src/state/groupings-migrate.ts": "migrates legacy grouping state into catalogue storage",
  "src/inbox/inbox-db.ts": "owns inbox persistence in the catalogue database",
  "src/sidebar/bench/fixtures.ts": "creates generated SQLite fixtures outside request paths",
  "src/sidebar/bench/benchmark.ts": "mutates generated fixtures only to measure changed snapshots and contention",
  "scripts/backfill-identity-from-cwd.ts": "the one-time maintenance script links catalogue rows to recovered identities",
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

function repositoryFiles(): string[] {
  return [...filesUnder(SRC), ...filesUnder(SCRIPTS)];
}

function repoPath(file: string): string {
  return relative(ROOT, file);
}

function isTest(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

const OLD_CROSS_DIRECTORY_BARREL_IMPORT = /(?:from\s*|import\s*\(\s*)["'][^"']*catalogue\/db(?:\.ts)?["']/;
const OLD_SAME_DIRECTORY_BARREL_IMPORT = /(?:from\s*|import\s*\(\s*)["']\.\/db(?:\.ts)?["']/;
const MUTATION_MODULE_IMPORT = /(?:from\s*|import\s*\(\s*)["'][^"']*catalogue\/db-mutations(?:\.ts)?["']|from\s*["']\.\/db-mutations(?:\.ts)?["']/;
const MUTATION_SQL = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE)\b/i;
const PROTECTED_TABLE = /\b(?:catalogue|session_tags|identities|identity_[a-z_]+|groupings|inboxes|historical_detached_child_backfills)\b/i;

function containsProtectedMutationSql(source: string): boolean {
  for (const match of source.matchAll(/\.(?:query|exec)\s*\(\s*(["'`])([\s\S]*?)\1/g)) {
    const sql = match[2] ?? "";
    if (MUTATION_SQL.test(sql) && PROTECTED_TABLE.test(sql)) return true;
  }
  return false;
}

test("the deleted catalogue db barrel cannot be imported from source, tests, or scripts", () => {
  const violations = repositoryFiles()
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      return OLD_CROSS_DIRECTORY_BARREL_IMPORT.test(source)
        || (file.startsWith(join(SRC, "catalogue")) && OLD_SAME_DIRECTORY_BARREL_IMPORT.test(source));
    })
    .map(repoPath);
  expect(violations).toEqual([]);
});

test("only sanctioned production modules import db-mutations.ts", () => {
  const violations: string[] = [];
  for (const file of repositoryFiles()) {
    if (isTest(file)) continue;
    const source = readFileSync(file, "utf8");
    if (!MUTATION_MODULE_IMPORT.test(source)) continue;
    const path = repoPath(file);
    if (!(path in SANCTIONED_MUTATION_IMPORTERS)) {
      violations.push(`${path} imports db-mutations.ts without a sanctioned-writer reason`);
    }
  }
  expect(violations).toEqual([]);
});

test("raw protected catalogue mutation SQL stays in sanctioned storage modules", () => {
  const violations: string[] = [];
  for (const file of repositoryFiles()) {
    if (isTest(file)) continue;
    const source = readFileSync(file, "utf8");
    if (!containsProtectedMutationSql(source)) continue;
    const path = repoPath(file);
    if (!(path in SANCTIONED_RAW_SQL_WRITERS)) {
      violations.push(`${path} constructs protected catalogue mutation SQL without a storage-owner reason`);
    }
  }
  expect(violations).toEqual([]);
});

test("sidebar request modules use query-only adapters and never construct a writer", () => {
  const violations: string[] = [];
  for (const file of filesUnder(join(SRC, "sidebar"))) {
    const path = repoPath(file);
    if (isTest(file) || path.startsWith("src/sidebar/bench/")) continue;
    const source = readFileSync(file, "utf8");
    if (MUTATION_MODULE_IMPORT.test(source)) violations.push(`${path} imports db-mutations.ts`);
    if (/\bopenCatalogue\s*\(/.test(source)) violations.push(`${path} opens the catalogue writer`);
    for (const match of source.matchAll(/new\s+Database\s*\(([^;]+)\)/g)) {
      if (!/readonly\s*:\s*true/.test(match[1] ?? "")) {
        violations.push(`${path} constructs a non-readonly Database`);
      }
    }
    if (containsProtectedMutationSql(source)) violations.push(`${path} constructs protected mutation SQL`);
  }
  expect(violations).toEqual([]);
});
