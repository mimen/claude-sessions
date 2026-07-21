import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { openIndex } from "../index/schema.ts";
import { openCatalogue } from "./db.ts";
import { historicalDetachedChildBackfillCommand } from "./historical-detached-child-backfill.ts";

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const CHILD_RESUME_ID = "legacy-child-resume-id";
const NOW = "2026-07-20T12:00:00.000Z";

interface Fixture {
  readonly root: string;
  readonly indexPath: string;
  readonly cataloguePath: string;
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly cleanup: () => void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ccs-historical-backfill-"));
  const cache = join(root, "cache");
  const indexPath = join(cache, "index.db");
  const cataloguePath = join(cache, "catalogue.db");
  const manifestPath = join(root, "manifest.json");
  mkdirSync(cache, { recursive: true });

  const index = openIndex(indexPath);
  seedIndex(index, PARENT, PARENT);
  seedIndex(index, CHILD, CHILD_RESUME_ID);
  index.close();

  const catalogue = openCatalogue(cataloguePath);
  catalogue.query("INSERT INTO catalogue (session_id, updated_at) VALUES ($id, $now)").run({ $id: CHILD, $now: NOW });
  catalogue.query("INSERT INTO session_tags (session_id, entity) VALUES ($id, 'keep-me')").run({ $id: CHILD });
  catalogue.close();

  const raw = `${JSON.stringify({
    version: 1,
    mode: "report_only",
    findings: [
      exactFinding(),
      {
        status: "unmatched",
        reason: "provider mismatch",
        parentSessionId: PARENT,
        candidateSessionIds: [],
        proposal: null,
        evidence: evidence(),
      },
    ],
  }, null, 2)}\n`;
  writeFileSync(manifestPath, raw, "utf8");
  return {
    root,
    indexPath,
    cataloguePath,
    manifestPath,
    manifestHash: createHash("sha256").update(raw).digest("hex"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedIndex(index: ReturnType<typeof openIndex>, sessionId: string, resumeId: string): void {
  index.query(
    `INSERT INTO sessions (
       session_id, host, path, cwd, project_root, project_name, fallback_label,
       first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id
     ) VALUES ($sessionId, 'test', $path, '/repo', '/repo', 'repo', 'fixture', $now, $now, 1, 0, 0, 0, $resumeId)`,
  ).run({ $sessionId: sessionId, $path: `/store/${sessionId}.jsonl`, $now: NOW, $resumeId: resumeId });
}

function evidence(): Record<string, string | number | readonly string[] | null> {
  return {
    promptHash: "a".repeat(64),
    parentTranscriptPath: "/store/parent.jsonl",
    parentLine: 42,
    launchTimestamp: NOW,
    candidateTranscriptPath: "/store/child.jsonl",
    candidateTimestamp: NOW,
    matchedDimensions: ["prompt", "cwd", "entrypoint", "provider", "model", "timestamp"],
  };
}

function exactFinding() {
  const proof = evidence();
  return {
    status: "proposed",
    reason: null,
    parentSessionId: PARENT,
    candidateSessionIds: [CHILD_RESUME_ID],
    proposal: {
      sessionClass: "auxiliary",
      causalParentSessionId: PARENT,
      tags: ["historical-cleanup", "detached-child", "auxiliary"],
      provenance: proof,
    },
    evidence: proof,
  };
}

function commandArgs(f: Fixture, apply = false): string[] {
  return [
    "detached-children",
    "--manifest", f.manifestPath,
    "--expect-sha256", f.manifestHash,
    "--index", f.indexPath,
    "--catalogue", f.cataloguePath,
    ...(apply ? ["--apply"] : []),
  ];
}

function childState(f: Fixture): { sessionClass: string | null; parentSessionId: string | null; meta: string | null; tags: string[]; auditCount: number; revertedAt: string | null } {
  const db = openCatalogue(f.cataloguePath);
  const row = db.query(
    "SELECT session_class AS sessionClass, parent_session_id AS parentSessionId, meta FROM catalogue WHERE session_id = $id",
  ).get({ $id: CHILD }) as { sessionClass: string | null; parentSessionId: string | null; meta: string | null };
  const tags = (db.query("SELECT entity FROM session_tags WHERE session_id = $id ORDER BY entity").all({ $id: CHILD }) as { entity: string }[])
    .map((tag) => tag.entity);
  const audit = db.query("SELECT COUNT(*) AS count, MAX(reverted_at) AS revertedAt FROM historical_detached_child_backfills").get() as {
    count: number;
    revertedAt: string | null;
  };
  db.close();
  return { ...row, tags, auditCount: audit.count, revertedAt: audit.revertedAt };
}

describe("historical detached-child backfill", () => {
  test("dry-run is read-only, apply is exact-only and repeatable, and rollback restores the recorded fields", () => {
    const f = fixture();
    try {
      expect(historicalDetachedChildBackfillCommand(commandArgs(f))).toBe(0);
      expect(childState(f)).toEqual({
        sessionClass: null,
        parentSessionId: null,
        meta: null,
        tags: ["keep-me"],
        auditCount: 0,
        revertedAt: null,
      });

      expect(historicalDetachedChildBackfillCommand(commandArgs(f, true))).toBe(0);
      const applied = childState(f);
      expect(applied.sessionClass).toBe("auxiliary");
      expect(applied.parentSessionId).toBe(PARENT);
      expect(applied.tags).toEqual(["auxiliary", "detached-child", "historical-cleanup", "keep-me"]);
      expect(JSON.parse(applied.meta ?? "{}")).toMatchObject({
        historical_detached_child_backfill: {
          version: 1,
          manifestSha256: f.manifestHash,
          causalParentSessionId: PARENT,
        },
      });
      expect(applied.auditCount).toBe(1);

      // A second apply validates the same manifest but does not create a second audit or overwrite.
      expect(historicalDetachedChildBackfillCommand(commandArgs(f, true))).toBe(0);
      expect(childState(f).auditCount).toBe(1);

      const auditDb = openCatalogue(f.cataloguePath);
      const audit = auditDb.query(
        "SELECT operation_id FROM historical_detached_child_backfills",
      ).get() as { operation_id: string };
      auditDb.close();
      const rollback = [
        "rollback", "--operation", audit.operation_id,
        "--index", f.indexPath, "--catalogue", f.cataloguePath,
      ];
      expect(historicalDetachedChildBackfillCommand(rollback)).toBe(0);
      expect(historicalDetachedChildBackfillCommand([...rollback, "--apply"])).toBe(0);
      expect(childState(f)).toMatchObject({
        sessionClass: null,
        parentSessionId: null,
        tags: ["keep-me"],
        auditCount: 1,
      });
      expect(childState(f).revertedAt).not.toBeNull();
      expect(JSON.parse(childState(f).meta ?? "{}")).not.toHaveProperty("historical_detached_child_backfill");
    } finally {
      f.cleanup();
    }
  });

  test("rollback removes the catalogue placeholder when the child had no preexisting row", () => {
    const f = fixture();
    try {
      const seed = openCatalogue(f.cataloguePath);
      seed.query("DELETE FROM session_tags WHERE session_id = $id").run({ $id: CHILD });
      seed.query("DELETE FROM catalogue WHERE session_id = $id").run({ $id: CHILD });
      seed.close();

      expect(historicalDetachedChildBackfillCommand(commandArgs(f, true))).toBe(0);
      const auditDb = openCatalogue(f.cataloguePath);
      const audit = auditDb.query("SELECT operation_id FROM historical_detached_child_backfills").get() as {
        operation_id: string;
      };
      auditDb.close();
      expect(historicalDetachedChildBackfillCommand([
        "rollback", "--operation", audit.operation_id,
        "--index", f.indexPath, "--catalogue", f.cataloguePath, "--apply",
      ])).toBe(0);

      const check = openCatalogue(f.cataloguePath);
      const row = check.query("SELECT 1 AS found FROM catalogue WHERE session_id = $id").get({ $id: CHILD });
      const tags = check.query("SELECT 1 AS found FROM session_tags WHERE session_id = $id").get({ $id: CHILD });
      check.close();
      expect(row).toBeNull();
      expect(tags).toBeNull();
    } finally {
      f.cleanup();
    }
  });

  test("migrates a v35 catalogue to add the audited backfill table", () => {
    const f = fixture();
    try {
      const before = openCatalogue(f.cataloguePath);
      before.exec("DROP TABLE historical_detached_child_backfills;");
      before.exec("PRAGMA user_version = 35;");
      before.close();

      const migrated = openCatalogue(f.cataloguePath);
      const table = migrated.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'historical_detached_child_backfills'",
      ).get() as { name: string } | null;
      migrated.close();
      expect(table?.name).toBe("historical_detached_child_backfills");
    } finally {
      f.cleanup();
    }
  });

  test("requires a pinned reviewed manifest and refuses a pre-existing conflicting class", () => {
    const f = fixture();
    try {
      const wrongHash = "0".repeat(64);
      expect(historicalDetachedChildBackfillCommand([
        "detached-children", "--manifest", f.manifestPath, "--expect-sha256", wrongHash,
        "--index", f.indexPath, "--catalogue", f.cataloguePath,
      ])).toBe(2);
      expect(childState(f).auditCount).toBe(0);

      const db = openCatalogue(f.cataloguePath);
      db.query("UPDATE catalogue SET session_class = 'work_body' WHERE session_id = $id").run({ $id: CHILD });
      db.close();
      expect(historicalDetachedChildBackfillCommand(commandArgs(f))).toBe(1);
      expect(childState(f)).toMatchObject({ sessionClass: "work_body", parentSessionId: null, auditCount: 0 });
    } finally {
      f.cleanup();
    }
  });
});
