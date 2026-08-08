import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setParent, setSessionClass } from "./db-mutations.ts";
import { openCatalogue } from "./db-schema.ts";
import { categoryBackfillCommand } from "./category-backfill.ts";
import { getCategoryAssignment } from "../categories/assignment.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("category backfill rejects malformed manifest JSON without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-category-backfill-invalid-"));
  roots.push(root);
  const cataloguePath = join(root, "catalogue.db");
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, "{not-json");
  openCatalogue(cataloguePath, { materialize: false }).close();
  const sha = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  const errors: string[] = [];
  const error = spyOn(console, "error").mockImplementation((value: object) => errors.push(String(value)));
  try {
    expect(categoryBackfillCommand([
      "apply", "--manifest", manifestPath, "--expect-sha256", sha, "--catalogue", cataloguePath,
    ])).toBe(1);
  } finally {
    error.mockRestore();
  }
  expect(errors.join("\n")).toContain("manifest is not valid JSON");
});

test("category backfill is dry-run by default, normalizes auxiliary tags, is idempotent, and rolls back", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-category-backfill-"));
  roots.push(root);
  const cataloguePath = join(root, "catalogue.db");
  const registryPath = join(root, "ClaudeConfig", "categories", "registry.json");
  const manifestPath = join(root, "manifest.json");
  mkdirSync(join(root, "ClaudeConfig", "categories"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({
    $schema: "./registry.schema.json", version: "1.0.0", source: "Life Domains.md",
    categories: [{ slug: "events", name: "Events", compactLabel: "Events", order: 1,
      todoistColorName: "Purple", todoistColor: "grape", hex: "#692EC2", scope: "Events", googleLabelName: "Events", workspaceRoot: "Workspaces/Events" }],
  }));
  writeFileSync(manifestPath, JSON.stringify({
    schema: 1, operation: "normalize-domain-tags", registryVersion: "1.0.0", auxiliaryPolicy: "resolve-root",
    conflictPolicy: "use-existing-valid-assignment-or-report", invalidPolicy: "discard-invalid-only-when-one-valid-category-remains",
  }));
  const sha = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  const db = openCatalogue(cataloguePath, { materialize: false });
  setSessionClass(db, "root", "work_body", "2026-08-07T00:00:00Z");
  setSessionClass(db, "child", "auxiliary", "2026-08-07T00:00:00Z");
  setParent(db, "child", "root", "2026-08-07T00:00:00Z");
  db.query("INSERT INTO session_tags(session_id,entity) VALUES ('child','domain:events')").run();
  db.query("INSERT INTO session_category_attempts(session_id,attempts,next_attempt_at,last_error) VALUES ('root',5,'2026-08-08T00:00:00Z','root exhausted')").run();
  db.query("INSERT INTO session_category_attempts(session_id,attempts,next_attempt_at,last_error) VALUES ('child',4,'2026-08-08T01:00:00Z','child retry')").run();
  db.close();

  const args = ["apply", "--manifest", manifestPath, "--expect-sha256", sha, "--catalogue", cataloguePath, "--registry", registryPath];
  expect(categoryBackfillCommand(args)).toBe(0);
  let check = openCatalogue(cataloguePath, { materialize: false });
  expect(getCategoryAssignment(check, "root")).toBeNull();
  check.close();

  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((value: object) => lines.push(String(value)));
  try {
    expect(categoryBackfillCommand([...args, "--apply"])).toBe(0);
  } finally {
    log.mockRestore();
  }
  const operation = lines.join("\n").match(/audit operation ([0-9a-f-]+)/)?.[1];
  expect(operation).toBeDefined();
  check = openCatalogue(cataloguePath, { materialize: false });
  expect(getCategoryAssignment(check, "root")?.slug).toBe("events");
  expect(getCategoryAssignment(check, "child")).toBeNull();
  expect(check.query("SELECT entity FROM session_tags WHERE session_id='child'").all()).toEqual([]);
  expect(check.query("SELECT session_id,attempts,next_attempt_at,last_error FROM session_category_attempts ORDER BY session_id").all()).toEqual([
    { session_id: "root", attempts: 5, next_attempt_at: "2026-08-08T00:00:00Z", last_error: "root exhausted" },
  ]);
  check.close();

  expect(categoryBackfillCommand([...args, "--apply"])).toBe(0);
  check = openCatalogue(cataloguePath, { materialize: false });
  check.query("UPDATE session_category_attempts SET attempts=1,last_error='changed after apply' WHERE session_id='root'").run();
  check.close();
  expect(categoryBackfillCommand(["rollback", "--operation", operation!, "--catalogue", cataloguePath, "--registry", registryPath, "--apply"])).toBe(1);
  check = openCatalogue(cataloguePath, { materialize: false });
  check.query("UPDATE session_category_attempts SET attempts=5,next_attempt_at='2026-08-08T00:00:00Z',last_error='root exhausted' WHERE session_id='root'").run();
  check.close();
  expect(categoryBackfillCommand(["rollback", "--operation", operation!, "--catalogue", cataloguePath, "--registry", registryPath, "--apply"])).toBe(0);
  check = openCatalogue(cataloguePath, { materialize: false });
  expect(getCategoryAssignment(check, "root")).toBeNull();
  expect(check.query("SELECT entity FROM session_tags WHERE session_id='child'").all()).toEqual([{ entity: "domain:events" }]);
  expect(check.query("SELECT session_id,attempts,next_attempt_at,last_error FROM session_category_attempts ORDER BY session_id").all()).toEqual([
    { session_id: "child", attempts: 4, next_attempt_at: "2026-08-08T01:00:00Z", last_error: "child retry" },
    { session_id: "root", attempts: 5, next_attempt_at: "2026-08-08T00:00:00Z", last_error: "root exhausted" },
  ]);
  check.close();
});

test("category backfill preserves matching manual-lock metadata while cleaning child state", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-category-backfill-lock-"));
  roots.push(root);
  const cataloguePath = join(root, "catalogue.db");
  const registryPath = join(root, "ClaudeConfig", "categories", "registry.json");
  const manifestPath = join(root, "manifest.json");
  mkdirSync(join(root, "ClaudeConfig", "categories"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({
    $schema: "./registry.schema.json", version: "1.0.0", source: "Life Domains.md",
    categories: [{ slug: "events", name: "Events", compactLabel: "Events", order: 1,
      todoistColorName: "Purple", todoistColor: "grape", hex: "#692EC2", scope: "Events", googleLabelName: "Events", workspaceRoot: "Workspaces/Events" }],
  }));
  writeFileSync(manifestPath, JSON.stringify({
    schema: 1, operation: "normalize-domain-tags", registryVersion: "1.0.0", auxiliaryPolicy: "resolve-root",
    conflictPolicy: "use-existing-valid-assignment-or-report", invalidPolicy: "discard-invalid-only-when-one-valid-category-remains",
  }));
  const sha = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  const db = openCatalogue(cataloguePath, { materialize: false });
  setSessionClass(db, "root", "work_body", "2026-08-07T00:00:00Z");
  setSessionClass(db, "child", "auxiliary", "2026-08-07T00:00:00Z");
  setParent(db, "child", "root", "2026-08-07T00:00:00Z");
  db.query("INSERT INTO session_category_assignments(session_id,slug,source,classifier_version,classified_at,manual_lock,failed_write) VALUES ('root','events','manual','0.8.0',$at,1,'keep failure')").run({ $at: "2026-08-07T00:00:00Z" });
  db.query("INSERT INTO session_tags(session_id,entity) VALUES ('child','domain:events')").run();
  db.close();
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((value: object) => lines.push(String(value)));
  try {
    expect(categoryBackfillCommand([
      "apply", "--manifest", manifestPath, "--expect-sha256", sha, "--catalogue", cataloguePath,
      "--registry", registryPath, "--apply",
    ])).toBe(0);
  } finally {
    log.mockRestore();
  }
  expect(lines.join("\n")).toContain("applied 0 category roots; preserved 1 matching manual locks");
  const check = openCatalogue(cataloguePath, { materialize: false });
  expect(getCategoryAssignment(check, "root")).toMatchObject({
    slug: "events", source: "manual", classifierVersion: "0.8.0", manualLock: true, failedWrite: "keep failure",
  });
  expect(check.query("SELECT entity FROM session_tags WHERE session_id='root'").all()).toEqual([{ entity: "domain:events" }]);
  expect(check.query("SELECT entity FROM session_tags WHERE session_id='child'").all()).toEqual([]);
  check.close();
});
