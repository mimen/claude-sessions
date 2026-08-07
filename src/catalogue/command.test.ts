import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceEngine } from "../inference/engine.ts";
import { getCategoryAssignment } from "../categories/assignment.ts";
import { openCatalogue } from "./db-schema.ts";
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
    version: 1,
    classifier_version: "v1",
    categories: [{ slug: "ai-systems", name: "AI Systems", compact_name: "AI", color: "#2A67E2" }],
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
      applyMutations(db, [{ sessionId: SESSION.sessionId, op: "category", value: "ai-systems" }], NOW);
      expect(getCategoryAssignment(db, SESSION.sessionId)).toMatchObject({
        slug: "ai-systems",
        source: "manual",
        manualLock: true,
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
