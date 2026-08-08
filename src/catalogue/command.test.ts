import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceEngine } from "../inference/engine.ts";
import { getCategoryAssignment, setCategory } from "../categories/assignment.ts";
import { loadCategoryRegistry } from "../categories/registry.ts";
import { openCatalogue } from "./db-schema.ts";
import { ensureRow } from "./db-mutations.ts";
import { applyMutations, runMetadataCommand, type SessionMeta } from "./command.ts";

const NOW = "2026-08-07T00:00:00.000Z";
const SESSION: SessionMeta = {
  sessionId: "session-1",
  title: "Category work",
  kind: "session",
  key: null,
  parentSessionId: null,
  completed: false,
  archived: false,
  project: null,
  repo: "claude-sessions",
};

const originalRegistryPath = process.env.CCS_CATEGORY_REGISTRY_PATH;
let tempDir: string | null = null;

afterEach(() => {
  if (originalRegistryPath === undefined) delete process.env.CCS_CATEGORY_REGISTRY_PATH;
  else process.env.CCS_CATEGORY_REGISTRY_PATH = originalRegistryPath;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function installRegistry(): void {
  tempDir = mkdtempSync(join(tmpdir(), "ccs-category-command-"));
  const path = join(tempDir, "categories.json");
  writeFileSync(path, JSON.stringify({
    $schema: "./registry.schema.json", version: "1.0.0", source: "Life Domains.md",
    categories: [{ slug: "ai-systems", name: "AI Systems", compactLabel: "AI", order: 1,
      todoistColorName: "Blue", todoistColor: "blue", hex: "#2A67E2", scope: "AI", googleLabelName: "AI", workspaceRoot: "Workspaces/Assistant" }],
  }));
  process.env.CCS_CATEGORY_REGISTRY_PATH = path;
}

function engineWith(result: unknown): InferenceEngine {
  return {
    name: "codex",
    available: () => true,
    runStructured: async () => result,
  };
}

describe("natural-language category mutations", () => {
  test("parses category as a first-class operation", async () => {
    const result = await runMetadataCommand(
      "put this in AI Systems",
      [SESSION],
      SESSION.sessionId,
      engineWith({ mutations: [{ n: 1, op: "category", value: "ai-systems" }] }),
    );
    expect(result).toEqual({
      mutations: [{ sessionId: SESSION.sessionId, op: "category", value: "ai-systems" }],
    });
  });

  test("assigns and clears through the atomic category boundary", () => {
    installRegistry();
    const db = openCatalogue(":memory:");
    try {
      ensureRow(db, SESSION.sessionId, NOW);
      applyMutations(db, [{ sessionId: SESSION.sessionId, op: "category", value: "ai-systems" }], NOW);
      expect(getCategoryAssignment(db, SESSION.sessionId)).toMatchObject({
        slug: "ai-systems",
        source: "model",
        manualLock: false,
      });
      expect(db.query("SELECT entity FROM session_tags WHERE session_id = $id").all({ $id: SESSION.sessionId }))
        .toEqual([{ entity: "domain:ai-systems" }]);

      applyMutations(db, [{ sessionId: SESSION.sessionId, op: "category", value: null }], NOW);
      expect(getCategoryAssignment(db, SESSION.sessionId)).toBeNull();
      expect(db.query("SELECT entity FROM session_tags WHERE session_id = $id").all({ $id: SESSION.sessionId }))
        .toEqual([]);
    } finally {
      db.close();
    }
  });

  test("rejects locked changes and rolls a mixed batch back atomically", () => {
    installRegistry();
    const registry = loadCategoryRegistry(process.env.CCS_CATEGORY_REGISTRY_PATH!);
    if (!registry.ok) throw registry.error;
    const db = openCatalogue(":memory:");
    try {
      ensureRow(db, SESSION.sessionId, NOW);
      setCategory(db, registry.value, {
        sessionId: SESSION.sessionId, auxiliaryPolicy: "reject", slug: "ai-systems", source: "manual",
        manualLock: true, classifiedAt: NOW, allowLockedOverride: true,
      });
      expect(() => applyMutations(db, [
        { sessionId: SESSION.sessionId, op: "title", value: "should roll back" },
        { sessionId: SESSION.sessionId, op: "category", value: null },
      ], NOW)).toThrow("manually locked");
      expect(db.query("SELECT custom_title FROM catalogue WHERE session_id=$id").get({ $id: SESSION.sessionId }))
        .toEqual({ custom_title: null });
      expect(getCategoryAssignment(db, SESSION.sessionId)).toMatchObject({ slug: "ai-systems", manualLock: true, source: "manual" });
    } finally {
      db.close();
    }
  });

  test("fails honestly when no category registry is installed", () => {
    process.env.CCS_CATEGORY_REGISTRY_PATH = join(tmpdir(), "missing-ccs-categories.json");
    const db = openCatalogue(":memory:");
    try {
      expect(() => applyMutations(
        db,
        [{ sessionId: SESSION.sessionId, op: "category", value: "ai-systems" }],
        NOW,
      )).toThrow(/category registry/i);
    } finally {
      db.close();
    }
  });
});
