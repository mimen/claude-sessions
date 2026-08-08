import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { setParent, setResumeId, setSessionClass } from "../catalogue/db-mutations.ts";
import { setCategory } from "../categories/assignment.ts";
import { loadCategoryRegistry } from "../categories/registry.ts";
import { readSidebarCategoryProjection } from "./category-projection.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("sidebar category projection exposes inherited labels, exact registry color, provenance, and version", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-sidebar-category-"));
  roots.push(root);
  const cataloguePath = join(root, "catalogue.db");
  const registryPath = join(root, "ClaudeConfig", "categories", "registry.json");
  mkdirSync(join(root, "ClaudeConfig", "categories"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({
    $schema: "./registry.schema.json", version: "1.0.0", source: "Life Domains.md",
    categories: [{ slug: "events", name: "Events, Booking & Live Production", compactLabel: "Events", order: 1,
      todoistColorName: "Purple", todoistColor: "grape", hex: "#692EC2", scope: "Events", googleLabelName: "Events", workspaceRoot: "Workspaces/Events" }],
  }));
  const registry = loadCategoryRegistry(registryPath);
  if (!registry.ok) throw registry.error;
  const db = openCatalogue(cataloguePath, { materialize: false });
  setSessionClass(db, "root", "work_body", "2026-08-07T00:00:00Z");
  setSessionClass(db, "child", "auxiliary", "2026-08-07T00:00:00Z");
  setResumeId(db, "child", "resume-child", "2026-08-07T00:00:00Z");
  setParent(db, "child", "root", "2026-08-07T00:00:00Z");
  setCategory(db, registry.value, { sessionId: "root", auxiliaryPolicy: "reject", slug: "events", source: "manual", manualLock: true, classifiedAt: "2026-08-07T00:00:00Z" });
  db.close();
  const outcome = readSidebarCategoryProjection(cataloguePath, registryPath);
  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") return;
  expect(outcome.categories.get("resume-child")).toMatchObject({
    schema: 1, effectiveSlug: "events", compactLabel: "Events", fullLabel: "Events, Booking & Live Production",
    hex: "#692EC2", source: "manual", manualLock: true, finding: "inherited", registryVersion: "1.0.0",
  });
});

test("rejected auxiliary assignments do not leak provenance or manual lock", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-sidebar-category-rejected-"));
  roots.push(root);
  const cataloguePath = join(root, "catalogue.db");
  const registryPath = join(root, "ClaudeConfig", "categories", "registry.json");
  mkdirSync(join(root, "ClaudeConfig", "categories"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({
    $schema: "./registry.schema.json", version: "1.0.0", source: "Life Domains.md",
    categories: [{ slug: "events", name: "Events", compactLabel: "Events", order: 1,
      todoistColorName: "Purple", todoistColor: "grape", hex: "#692EC2", scope: "Events", googleLabelName: "Events", workspaceRoot: "Workspaces/Events" }],
  }));
  const db = openCatalogue(cataloguePath, { materialize: false });
  setSessionClass(db, "orphan", "auxiliary", "2026-08-07T00:00:00Z");
  db.query("INSERT INTO session_category_assignments(session_id,slug,source,classifier_version,classified_at,manual_lock) VALUES ('orphan','events','manual','1.0.0',$at,1)").run({ $at: "2026-08-07T00:00:00Z" });
  db.close();
  const outcome = readSidebarCategoryProjection(cataloguePath, registryPath);
  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") return;
  expect(outcome.categories.get("orphan")).toMatchObject({
    effectiveSlug: null,
    finding: "parentless-auxiliary",
    source: null,
    manualLock: false,
  });
});
