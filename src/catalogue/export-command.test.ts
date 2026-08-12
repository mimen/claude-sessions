/**
 * Tests for the D1 export contract. The export shape is the tool↔cluster interface — engines
 * couple to THIS schema instead of the private SQLite. Post-ADR-0089 v33, identity attributes
 * live on the identities table; the export flattens them into per-session rows so consumers
 * see the same envelope shape whether pre- or post-refactor.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "./db-schema.ts";
import { setCustomTitle } from "./db-mutations.ts";
import { mintIdentity, setIdentityFields } from "./identities.ts";
import { catalogueExport, buildExport, EXPORT_SCHEMA_VERSION } from "./export-command.ts";
import { setCategory } from "../categories/assignment.ts";
import type { CategoryRegistry } from "../categories/registry.ts";

const NOW = "2026-06-20T00:00:00Z";
const CATEGORY_REGISTRY: CategoryRegistry = {
  version: "1.0.0",
  classifierVersion: "1.0.0",
  sourcePath: "/vault/ClaudeConfig/categories/registry.json",
  vaultRoot: "/vault",
  categories: [{ slug: "ai-systems", name: "AI Systems", compactName: "AI", order: 1, color: "#2A67E2", scope: "AI", workspaceRoot: "Workspaces/Assistant", workspacePath: "/vault/Workspaces/Assistant" }],
};

/** Seed a session + identity + optional per-role attrs. Post-v33 pattern. */
function seed(
  db: import("bun:sqlite").Database,
  sid: string,
  cluster: string,
  role: string,
  attrs: Record<string, unknown> = {},
): string {
  const workRef = attrs.pr_repo && attrs.pr_number != null
    ? `${attrs.pr_repo}#${attrs.pr_number}`
    : attrs.gus_work
    ? String(attrs.gus_work)
    : null;
  const key = workRef ? `${cluster}:${role}:${workRef}` : `${cluster}:${role}`;
  mintIdentity(db, key, { cluster, role }, NOW);
  if (Object.keys(attrs).length > 0) {
    try {
      setIdentityFields(db, key, attrs, NOW);
    } catch {
      // per-role table absent (materialization skipped in :memory: without config) — ok
    }
  }
  setCustomTitle(db, sid, "seed", NOW);
  db.query("UPDATE catalogue SET identity_key = $k WHERE session_id = $sid").run({
    $k: key,
    $sid: sid,
  });
  return key;
}

test("export: schema field is stable", () => {
  const db = openCatalogue(":memory:");
  const out = catalogueExport(db, { cluster: null, role: null });
  expect(out.schema).toBe(EXPORT_SCHEMA_VERSION);
  expect(out.count).toBe(0);
  expect(out.rows).toEqual([]);
});

test("export: filters by cluster", () => {
  const db = openCatalogue(":memory:");
  seed(db, "s1", "pr-watch", "pr-agent");
  seed(db, "s2", "other", "pr-agent");
  const out = catalogueExport(db, { cluster: "pr-watch", role: null });
  expect(out.count).toBe(1);
  expect(out.rows[0]!.sessionId).toBe("s1");
  expect(out.cluster).toBe("pr-watch");
});

test("export: filters by cluster AND role", () => {
  const db = openCatalogue(":memory:");
  seed(db, "s1", "pr-watch", "pr-agent");
  seed(db, "s2", "pr-watch", "control");
  seed(db, "s3", "pr-watch", "pr-agent");
  const out = catalogueExport(db, { cluster: "pr-watch", role: "pr-agent" });
  expect(out.count).toBe(2);
  expect(new Set(out.rows.map((r) => r.sessionId))).toEqual(new Set(["s1", "s3"]));
});

test("export: identity_key is the structured key", () => {
  const db = openCatalogue(":memory:");
  seed(db, "s1", "pr-watch", "pr-agent", { pr_repo: "heroku/dashboard", pr_number: 42 });
  const out = catalogueExport(db, { cluster: "pr-watch", role: null });
  // key is a legacy alias for identityKey now — both mirror the new structured form.
  expect(out.rows[0]!.identityKey).toBe("pr-watch:pr-agent:heroku/dashboard#42");
});

test("export: exposes stored and inherited effective categories and filters by effective category", () => {
  const db = openCatalogue(":memory:");
  try {
    seed(db, "parent", "category-test", "root");
    seed(db, "child", "category-test", "child");
    db.query("UPDATE catalogue SET parent_session_id = 'parent' WHERE session_id = 'child'").run();
    setCategory(db, CATEGORY_REGISTRY, {
      sessionId: "parent",
      auxiliaryPolicy: "reject",
      slug: "ai-systems",
      source: "manual",
      manualLock: true,
      classifiedAt: NOW,
    });

    const out = catalogueExport(db, { cluster: null, role: null, category: "ai-systems" });
    expect(out.count).toBe(2);
    expect(out.category).toBe("ai-systems");
    expect(out.rows.find((row) => row.sessionId === "parent")).toMatchObject({
      storedCategory: "ai-systems",
      effectiveCategory: "ai-systems",
      categoryFinding: "stored",
    });
    expect(out.rows.find((row) => row.sessionId === "child")).toMatchObject({
      storedCategory: null,
      effectiveCategory: "ai-systems",
      categoryFinding: "inherited",
    });
  } finally {
    db.close();
  }
});

test("buildExport: Saved is represented additively without changing schema v2", () => {
  const rows = [
    {
      sessionId: "saved", resumeId: null, customTitle: null, kind: "session" as const,
      completed: false, archived: false, saved: true, parkedTaskId: null, key: null,
      parentSessionId: null, sessionClass: null, role: null, resumeCommand: null, project: null,
      cluster: null, gusWork: null, workUnitId: null, groupingId: null,
      stage: null, statusLine: null, meta: {}, notes: null, updatedAt: NOW,
      prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null,
      identityKey: null,
    },
  ];
  const out = buildExport(rows, {}, NOW);
  expect(out.schema).toBe(2);
  expect(out.rows[0]).toMatchObject({ saved: true, completed: false, archived: false });
});

test("buildExport: pure — same inputs, deterministic output shape", () => {
  const rows = [
    {
      sessionId: "s1", resumeId: null, customTitle: null, kind: "session" as const,
      completed: false, archived: false, saved: false, parkedTaskId: null, key: "pr-watch:pr-agent:o/r#1",
      parentSessionId: null, sessionClass: null, role: "pr-agent", resumeCommand: null, project: null,
      cluster: "pr-watch", gusWork: null, workUnitId: null, groupingId: null,
      stage: null, statusLine: null, meta: {}, notes: null, updatedAt: NOW,
      prNumber: 1, prRepo: "o/r", prBranch: null, prState: null, prHeadSha: null,
      identityKey: "pr-watch:pr-agent:o/r#1",
    },
  ];
  const out = buildExport(rows, { cluster: "pr-watch", role: null }, NOW);
  expect(out.schema).toBe(EXPORT_SCHEMA_VERSION);
  expect(out.generatedAt).toBe(NOW);
  expect(out.count).toBe(1);
  expect(out.rows[0]!.identityKey).toBe("pr-watch:pr-agent:o/r#1");
});

test("`ccs catalogue export --cluster empty` on a fresh CCS_ROOT → {rows: []}, not SQLite crash", async () => {
  // Regression: `catalogueExportCommand` opened the DB before ensureDataDir(),
  // so a fresh CCS_ROOT crashed with SQLITE_CANTOPEN. Now it should return a
  // well-formed empty export instead.
  const root = mkdtempSync(join(tmpdir(), "ccs-cat-exp-"));
  const bin = join(process.cwd(), "bin", "ccs");
  try {
    const p = Bun.spawn([bin, "catalogue", "export", "--cluster", "empty"], {
      env: { ...process.env, CCS_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [rc, stdout, stderr] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    expect(rc).toBe(0);
    expect(stderr).not.toContain("SQLITE_CANTOPEN");
    expect(stderr).not.toContain("SQLiteError");
    const parsed = JSON.parse(stdout);
    expect(parsed.schema).toBe(EXPORT_SCHEMA_VERSION);
    expect(parsed.cluster).toBe("empty");
    expect(parsed.count).toBe(0);
    expect(parsed.rows).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
