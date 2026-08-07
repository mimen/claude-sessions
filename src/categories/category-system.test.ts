import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { loadLocationRegistry } from "../locations/registry.ts";
import {
  getAllCategoryAssignments,
  getCategoryAssignment,
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

function registry(): CategoryRegistry {
  return {
    version: "1",
    classifierVersion: "classifier-2",
    categories: [
      { slug: "ai-systems", name: "AI Systems", compactName: "AI", color: "#2A67E2", aliases: [] },
      { slug: "events", name: "Events", compactName: "Events", color: "#692EC2", aliases: [] },
    ],
    projectMappings: { ccs: "ai-systems" },
    pathMappings: { "/work/events": "events", "/work": "ai-systems" },
  };
}

describe("category registry", () => {
  test("loads the machine-readable contract and rejects unknown mapping slugs", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-category-"));
    roots.push(root);
    const path = join(root, "registry.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      classifier_version: "classifier-2",
      categories: [{ slug: "ai-systems", name: "AI Systems", compact_name: "AI", color: "#2a67e2" }],
      project_mappings: { ccs: "ai-systems" },
      path_mappings: {},
    }));
    const loaded = loadCategoryRegistry(path);
    expect(loaded.ok).toBeTrue();
    if (loaded.ok) expect(loaded.value.categories[0]?.color).toBe("#2A67E2");

    writeFileSync(path, JSON.stringify({
      version: 1,
      classifier_version: "classifier-2",
      categories: [{ slug: "ai-systems", name: "AI Systems", compact_name: "AI", color: "#2A67E2" }],
      project_mappings: { ccs: "missing" },
      path_mappings: {},
    }));
    expect(loadCategoryRegistry(path).ok).toBeFalse();
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

describe("atomic category assignment", () => {
  test("keeps one domain tag, provenance, and manual lock coherent", () => {
    const db = openCatalogue(":memory:", { materialize: false });
    const categories = registry();
    setCategory(db, categories, {
      sessionId: "root", slug: "ai-systems", source: "path", classifiedAt: "2026-08-07T00:00:00Z",
    });
    setCategory(db, categories, {
      sessionId: "root", slug: "events", source: "manual", manualLock: true,
      classifiedAt: "2026-08-07T00:01:00Z", allowLockedOverride: true,
    });
    const refused = setCategory(db, categories, {
      sessionId: "root", slug: "ai-systems", source: "model", classifiedAt: "2026-08-07T00:02:00Z",
    });
    expect(refused.status).toBe("locked");
    expect(db.query("SELECT entity FROM session_tags WHERE session_id='root'").all()).toEqual([{ entity: "domain:events" }]);
    expect(getCategoryAssignment(db, "root")?.source).toBe("manual");
    expect(() => setCategory(db, categories, {
      sessionId: "root", slug: "not-real", source: "model", classifiedAt: "2026-08-07T00:03:00Z",
    })).toThrow("unknown category");
    expect(getCategoryAssignment(db, "root")).toMatchObject({
      slug: "events",
      failedWrite: expect.stringContaining("unknown category"),
    });
    db.close();
  });

  test("resolves bounded inheritance and reports broken ancestry", () => {
    const db = openCatalogue(":memory:", { materialize: false });
    setCategory(db, registry(), {
      sessionId: "root", slug: "events", source: "manual", classifiedAt: "2026-08-07T00:00:00Z",
    });
    const assignments = getAllCategoryAssignments(db);
    expect(resolveEffectiveCategory("child", assignments, new Map([["child", "root"]]), new Set(["root", "child"]))).toMatchObject({
      slug: "events", finding: "inherited", inheritedFrom: "root",
    });
    expect(resolveEffectiveCategory("child", assignments, new Map([["child", "missing"]]), new Set(["child"])).finding).toBe("missing-parent");
    expect(resolveEffectiveCategory("a", assignments, new Map([["a", "b"], ["b", "a"]]), new Set(["a", "b"])).finding).toBe("cycle");
    db.close();
  });
});

test("deterministic classifier prefers specific paths and surfaces conflicts", () => {
  expect(classifyCategory({ registry: registry(), project: null, cwd: "/work/events/2026" })).toEqual({
    status: "resolved",
    value: { slug: "events", source: "path", confidence: 0.9, evidence: "path:/work/events" },
  });
  expect(classifyCategory({ registry: registry(), project: "ccs", cwd: "/work/events/2026" })).toEqual({
    status: "unresolved", reason: "ambiguous",
  });
});

test("a category-neutral location contributes no evidence but permits project and path classification", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-neutral-location-"));
  roots.push(root);
  const path = join(root, "locations.toml");
  writeFileSync(path, `version = 1\ndefault_host = "mac"\n\n[[location]]\nkey = "neutral"\nname = "Neutral"\ncwd = "/work"\nkind = "workspace"\neligible_hosts = ["mac"]\npreferred_host = "mac"\ncategory_neutral = true\n`);
  const locations = loadLocationRegistry(path);
  expect(locations.ok).toBeTrue();
  if (!locations.ok) return;
  expect(classifyCategory({
    registry: registry(),
    locations: locations.value,
    locationKey: "neutral",
    project: "ccs",
    cwd: null,
  })).toMatchObject({ status: "resolved", value: { slug: "ai-systems", source: "project" } });
});

test("category staleness rejects malformed domain tags", () => {
  expect(categoryStaleness({ assignment: null, tags: ["domain:NOT-A-SLUG"], registry: registry() })).toEqual({
    stale: true,
    reasons: ["category-missing", "category-invalid"],
    needsModelFallback: true,
  });
});

test("category staleness is independent and includes classifier drift", () => {
  const assignment = {
    sessionId: "root", slug: "ai-systems", source: "path" as const, confidence: 1,
    classifierVersion: "classifier-1", classifiedAt: "2026-08-07T00:00:00Z",
    manualLock: false, evidence: null, failedWrite: null,
  };
  expect(categoryStaleness({ assignment, tags: ["domain:ai-systems"], registry: registry() })).toEqual({
    stale: true, reasons: ["category-version-drift"], needsModelFallback: false,
  });
});
