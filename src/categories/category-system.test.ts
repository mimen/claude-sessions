import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { ensureRow, setParent, setSessionClass } from "../catalogue/db-mutations.ts";
import { loadLocationRegistry } from "../locations/registry.ts";
import {
  getAllCategoryAssignments,
  getCategoryAssignment,
  getCategoryAttemptState,
  recordCategoryAttemptFailure,
  resolveEffectiveCategory,
  setCategory,
} from "./assignment.ts";
import { classifyCategory } from "./classify.ts";
import { loadCategoryRegistry, type CategoryRegistry } from "./registry.ts";
import { categoryStaleness } from "./staleness.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function definition(slug: string, name: string, compactName: string, order: number, workspaceRoot: string) {
  return {
    slug, name, compactName, order, color: order === 1 ? "#2A67E2" : "#692EC2", scope: `${name} scope`,
    workspaceRoot, workspacePath: `/vault/${workspaceRoot}`,
  };
}

function registry(): CategoryRegistry {
  return {
    version: "1.0.0",
    classifierVersion: "1.0.0",
    sourcePath: "/vault/ClaudeConfig/categories/registry.json",
    vaultRoot: "/vault",
    categories: [
      definition("ai-systems", "AI Systems", "AI", 1, "Workspaces/Assistant"),
      definition("events", "Events", "Events", 2, "Workspaces/Events"),
    ],
  };
}

function ensure(db: ReturnType<typeof openCatalogue>, ...ids: string[]): void {
  for (const id of ids) ensureRow(db, id, "2026-08-07T00:00:00Z");
}

describe("category registry", () => {
  test("loads the canonical merged registry shape and canonical order", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-category-"));
    roots.push(root);
    const path = join(root, "registry.json");
    writeFileSync(path, JSON.stringify({
      $schema: "./registry.schema.json", version: "1.0.0", source: "Life Domains.md",
      categories: [{ slug: "ai-systems", name: "AI Systems", compactLabel: "AI", order: 1,
        todoistColorName: "Blue", todoistColor: "blue", hex: "#2A67E2", scope: "AI systems", googleLabelName: "AI", workspaceRoot: "Workspaces/Assistant" }],
    }));
    const loaded = loadCategoryRegistry(path);
    expect(loaded.ok).toBeTrue();
    if (loaded.ok) expect(loaded.value.categories[0]).toMatchObject({ color: "#2A67E2", compactName: "AI", order: 1 });
  });

  test("parses the actual registry merged in the canonical vault branch", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-real-category-"));
    roots.push(root);
    const path = join(root, "registry.json");
    const bytes = execFileSync("git", ["-C", "/Users/mimen/Documents/milad-vault", "show", "origin/main:ClaudeConfig/categories/registry.json"]);
    writeFileSync(path, bytes);
    const loaded = loadCategoryRegistry(path);
    expect(loaded.ok).toBeTrue();
    if (loaded.ok) {
      expect(loaded.value.version).toBe("1.0.0");
      expect(loaded.value.categories.map((category) => category.slug)).toEqual([
        "music", "health", "finance", "home", "social", "personal-apps", "knowledge", "ai-systems", "auf-platform", "events", "marketing",
      ]);
      expect(loaded.value.categories[0]).toMatchObject({ compactName: "Music", color: "#DC4C3E", workspaceRoot: "Workspaces/Music" });
    }
  });

  test("location parsing remains compatible and accepts future category hints", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-location-category-"));
    roots.push(root);
    const path = join(root, "locations.toml");
    writeFileSync(path, `version = 1\ndefault_host = "mac"\n\n[[location]]\nkey = "repo"\nname = "Repo"\ncwd = "/work/repo"\nkind = "repo"\neligible_hosts = ["mac"]\npreferred_host = "mac"\ncategory = "ai-systems"\n`);
    const loaded = loadLocationRegistry(path);
    expect(loaded.ok).toBeTrue();
    if (loaded.ok) expect(loaded.value.locations[0]?.category).toBe("ai-systems");
  });
});

test("category schema migration is numbered and idempotent", () => {
  const db = openCatalogue(":memory:", { materialize: false });
  expect(db.query("SELECT version FROM category_schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }]);
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session_category_assignments','session_category_attempts','category_backfill_audits') ORDER BY name").all()).toHaveLength(3);
  db.close();
});

test("category attempts have an independent bounded exponential backoff", () => {
  const db = openCatalogue(":memory:", { materialize: false });
  ensure(db, "root");
  const start = new Date("2026-08-07T00:00:00Z");
  for (let index = 0; index < 7; index++) recordCategoryAttemptFailure(db, "root", new Error(`failure ${index}`), start);
  expect(getCategoryAttemptState(db, "root")).toEqual({
    attempts: 5,
    nextAttemptAt: "2026-08-07T04:00:00.000Z",
    lastError: "failure 6",
  });
  db.close();
});

describe("atomic category assignment", () => {
  test("rejects nonexistent and auxiliary storage while explicit resolution writes the retained root", () => {
    const db = openCatalogue(":memory:", { materialize: false });
    ensure(db, "root", "child");
    setSessionClass(db, "root", "work_body", "2026-08-07T00:00:00Z");
    setSessionClass(db, "child", "auxiliary", "2026-08-07T00:00:00Z");
    setParent(db, "child", "root", "2026-08-07T00:00:00Z");
    expect(() => setCategory(db, registry(), { sessionId: "typo", auxiliaryPolicy: "reject", slug: "events", source: "manual", classifiedAt: "2026-08-07T00:00:00Z" })).toThrow("does not exist");
    expect(() => setCategory(db, registry(), { sessionId: "child", auxiliaryPolicy: "reject", slug: "events", source: "manual", classifiedAt: "2026-08-07T00:00:00Z" })).toThrow("is auxiliary");
    const result = setCategory(db, registry(), { sessionId: "child", auxiliaryPolicy: "resolve-root", slug: "events", source: "manual", classifiedAt: "2026-08-07T00:00:00Z" });
    expect(result.status).toBe("written");
    expect(getCategoryAssignment(db, "root")?.slug).toBe("events");
    expect(getCategoryAssignment(db, "child")).toBeNull();
    db.close();
  });

  test("keeps one domain tag, provenance, and manual lock coherent without corrupting an invalid locked assignment", () => {
    const db = openCatalogue(":memory:", { materialize: false });
    ensure(db, "root");
    const categories = registry();
    setCategory(db, categories, { sessionId: "root", auxiliaryPolicy: "reject", slug: "ai-systems", source: "path", classifiedAt: "2026-08-07T00:00:00Z" });
    setCategory(db, categories, { sessionId: "root", auxiliaryPolicy: "reject", slug: "events", source: "manual", manualLock: true, classifiedAt: "2026-08-07T00:01:00Z", allowLockedOverride: true });
    const refused = setCategory(db, categories, { sessionId: "root", auxiliaryPolicy: "reject", slug: "ai-systems", source: "model", classifiedAt: "2026-08-07T00:02:00Z" });
    expect(refused.status).toBe("locked");
    expect(() => setCategory(db, categories, { sessionId: "root", auxiliaryPolicy: "reject", slug: "not-real", source: "model", classifiedAt: "2026-08-07T00:03:00Z" })).toThrow("unknown category");
    expect(getCategoryAssignment(db, "root")).toMatchObject({ slug: "events", source: "manual", failedWrite: null });
    db.close();
  });

  test("validates complete ancestry before accepting inherited assignments", () => {
    const db = openCatalogue(":memory:", { materialize: false });
    ensure(db, "root");
    setCategory(db, registry(), { sessionId: "root", auxiliaryPolicy: "reject", slug: "events", source: "manual", classifiedAt: "2026-08-07T00:00:00Z" });
    const assignments = getAllCategoryAssignments(db);
    const known = new Set(["root", "child", "tail"]);
    expect(resolveEffectiveCategory("child", assignments, new Map([["child", "root"]]), known)).toMatchObject({ slug: "events", finding: "inherited" });
    expect(resolveEffectiveCategory("child", assignments, new Map([["child", "root"], ["root", "child"]]), known).finding).toBe("cycle");
    expect(resolveEffectiveCategory("child", assignments, new Map([["child", "root"], ["root", "missing"]]), known).finding).toBe("missing-parent");
    expect(resolveEffectiveCategory("child", assignments, new Map([["child", "root"], ["root", "tail"]]), known, new Map(), 1).finding).toBe("depth-exceeded");
    expect(resolveEffectiveCategory("child", assignments, new Map(), new Set(["child"]), new Map([["child", "auxiliary"]])).finding).toBe("parentless-auxiliary");
    db.close();
  });
});

test("deterministic classifier uses precedence and canonical workspace roots", () => {
  expect(classifyCategory({ registry: registry(), cwd: "/vault/Workspaces/Events/2026" })).toMatchObject({
    status: "resolved", value: { slug: "events", source: "path" },
  });
  expect(classifyCategory({ registry: registry(), explicitSlug: "ai-systems", cwd: "/vault/Workspaces/Events/2026" })).toMatchObject({
    status: "resolved", value: { slug: "ai-systems", source: "manual" },
  });
});

test("plain cwd uses the most-specific registered location before workspace ancestry", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-specific-location-"));
  roots.push(root);
  const path = join(root, "locations.toml");
  writeFileSync(path, `version = 1\ndefault_host = "mac"\n\n[[location]]\nkey = "broad"\nname = "Broad"\ncwd = "/vault"\nkind = "workspace"\neligible_hosts = ["mac"]\npreferred_host = "mac"\ncategory = "ai-systems"\n\n[[location]]\nkey = "specific"\nname = "Specific"\ncwd = "/vault/Workspaces/Events"\nkind = "workspace"\neligible_hosts = ["mac"]\npreferred_host = "mac"\ncategory = "events"\n`);
  const locations = loadLocationRegistry(path);
  expect(locations.ok).toBeTrue();
  if (!locations.ok) return;
  expect(classifyCategory({ registry: registry(), locations: locations.value, cwd: "/vault/Workspaces/Events/project" })).toMatchObject({
    status: "resolved", value: { slug: "events", source: "location" },
  });
});

test("category-neutral location permits lower-precedence workspace classification", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-neutral-location-"));
  roots.push(root);
  const path = join(root, "locations.toml");
  writeFileSync(path, `version = 1\ndefault_host = "mac"\n\n[[location]]\nkey = "neutral"\nname = "Neutral"\ncwd = "/vault"\nkind = "workspace"\neligible_hosts = ["mac"]\npreferred_host = "mac"\ncategory_neutral = true\n`);
  const locations = loadLocationRegistry(path);
  expect(locations.ok).toBeTrue();
  if (!locations.ok) return;
  expect(classifyCategory({ registry: registry(), locations: locations.value, locationKey: "neutral", cwd: "/vault/Workspaces/Assistant/repo" })).toMatchObject({ status: "resolved", value: { slug: "ai-systems", source: "path" } });
});

test("category staleness filters unrelated tags and includes classifier drift", () => {
  const assignment = { sessionId: "root", slug: "ai-systems", source: "path" as const, confidence: 1, classifierVersion: "0.9.0", classifiedAt: "2026-08-07T00:00:00Z", manualLock: false, evidence: null, failedWrite: null, attempts: 0, nextAttemptAt: null };
  expect(categoryStaleness({ assignment, tags: ["Artist", "domain:ai-systems"], registry: registry() })).toEqual({ stale: true, reasons: ["category-version-drift"], needsModelFallback: false });
});
