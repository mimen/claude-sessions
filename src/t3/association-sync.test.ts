import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { markT3Associated } from "../catalogue/db-mutations.ts";
import { getRow } from "../catalogue/db-queries.ts";
import {
  matchT3Associations,
  syncT3Associations,
} from "./association-sync.ts";
import type {
  T3AttachmentStatus,
  T3AttachmentStatusClient,
} from "./status.ts";

function attachment(overrides: Partial<T3AttachmentStatus> = {}): T3AttachmentStatus {
  return {
    providerInstanceId: "claudeAgent",
    localSourceHost: "host",
    nativeSessionId: "resume-1",
    sourceCwd: "/repo",
    sourceId: "source",
    threadId: "thread",
    projectId: "project",
    state: "synced",
    lastSyncedAt: null,
    diagnostic: null,
    runtimeStatus: "stopped",
    runtimeLastSeenAt: null,
    ...overrides,
  };
}

const ROWS = [
  { sessionId: "canonical", resumeId: "resume-1", host: "host", cwd: "/repo" },
  { sessionId: "resume-1", resumeId: "different", host: "host", cwd: "/repo" },
];

test("resume aliases win before filename fallback and ambiguity tags nothing", () => {
  expect(matchT3Associations(ROWS, [attachment()], (cwd) => cwd)).toEqual({
    matches: [{ sessionId: "canonical", resumeId: "resume-1" }],
    ambiguous: 0,
  });

  expect(matchT3Associations([
    ...ROWS,
    { sessionId: "duplicate", resumeId: "resume-1", host: "host", cwd: "/repo" },
  ], [attachment()], (cwd) => cwd)).toEqual({ matches: [], ambiguous: 1 });
});

test("filename fallback is used only with no resume match and keeps identity checks", () => {
  const rows = [
    { sessionId: "native-id", resumeId: "other", host: "host", cwd: "/repo" },
    { sessionId: "wrong-host", resumeId: "none", host: "elsewhere", cwd: "/repo" },
    { sessionId: "wrong-cwd", resumeId: "none", host: "host", cwd: "/other" },
  ];
  expect(matchT3Associations(rows, [attachment({ nativeSessionId: "native-id" })], (cwd) => cwd)).toEqual({
    matches: [{ sessionId: "native-id", resumeId: "other" }],
    ambiguous: 0,
  });
  expect(matchT3Associations(rows, [attachment({ providerInstanceId: "other" })], (cwd) => cwd).matches).toEqual([]);
  expect(matchT3Associations(rows, [attachment()], () => { throw new Error("gone"); }).matches).toEqual([]);
});

function statusClient(attachments: readonly T3AttachmentStatus[]): T3AttachmentStatusClient {
  return {
    snapshot: async () => ({
      kind: "snapshot",
      snapshot: {
        protocolVersion: 1,
        generatedAt: "2026-08-22T00:00:00.000Z",
        attachments,
      },
    }),
  };
}

test("durable marking resolves the catalogue canonical row and never creates a stub", () => {
  const db = openCatalogue(":memory:", { materialize: false });
  try {
    db.query("INSERT INTO catalogue (session_id, resume_id) VALUES ('canonical', 'resume-1')").run();
    expect(markT3Associated(db, "later-index-row", "resume-1", "2026-08-22T00:00:00Z")).toBe("changed");
    expect(getRow(db, "canonical")?.t3Associated).toBeTrue();
    expect(getRow(db, "later-index-row")).toBeNull();
    expect(markT3Associated(db, "missing", "missing", "2026-08-22T00:00:00Z")).toBe("not-found");
    expect(getRow(db, "missing")).toBeNull();
  } finally {
    db.close();
  }
});

test("local T3 state backfills when the optional CLI is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-t3-local-state-"));
  const indexPath = join(root, "index.db");
  const cataloguePath = join(root, "catalogue.db");
  const localT3StatePath = join(root, "state.sqlite");
  try {
    const index = new Database(indexPath);
    index.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        resume_id TEXT,
        host TEXT NOT NULL,
        cwd TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sessions VALUES ('canonical', 'resume-local', 'host', '/repo', 0);
    `);
    index.close();
    const local = new Database(localT3StatePath);
    local.exec(`
      CREATE TABLE provider_session_runtime (
        provider_name TEXT NOT NULL,
        resume_cursor_json TEXT
      );
      INSERT INTO provider_session_runtime VALUES
        ('claudeAgent', '{"resume":"resume-local"}'),
        ('other', '{"resume":"ignore"}');
    `);
    local.close();
    const catalogue = openCatalogue(cataloguePath, { materialize: false });
    catalogue.query("INSERT INTO catalogue (session_id) VALUES ('canonical')").run();
    catalogue.close();

    const result = await syncT3Associations({
      statusClient: {
        snapshot: async () => ({ kind: "failure", reason: "missing-executable", message: "ENOENT" }),
      },
      indexPath,
      cataloguePath,
      localT3StatePath,
      resolveCwd: (cwd) => cwd,
    });
    expect(result).toMatchObject({ status: "synced", tagged: 1 });
    const read = openCatalogue(cataloguePath, { materialize: false });
    expect(getRow(read, "canonical")?.t3Associated).toBeTrue();
    read.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync writes a durable monotonic catalogue mark and is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-t3-sync-"));
  const indexPath = join(root, "index.db");
  const cataloguePath = join(root, "catalogue.db");
  try {
    const index = new Database(indexPath);
    index.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        resume_id TEXT,
        host TEXT NOT NULL,
        cwd TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sessions VALUES ('canonical', 'resume-1', 'host', '/repo', 0);
    `);
    index.close();
    const catalogue = openCatalogue(cataloguePath, { materialize: false });
    catalogue.query("INSERT INTO catalogue (session_id) VALUES ('canonical')").run();
    catalogue.close();

    const first = await syncT3Associations({
      statusClient: statusClient([attachment()]),
      indexPath,
      cataloguePath,
      localT3StatePath: join(root, "missing-t3.db"),
      resolveCwd: (cwd) => cwd,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
    });
    expect(first).toMatchObject({ status: "synced", tagged: 1, conflicts: 0 });

    const read = openCatalogue(cataloguePath, { materialize: false });
    expect(getRow(read, "canonical")).toMatchObject({
      resumeId: "resume-1",
      t3Associated: true,
    });
    read.close();

    const repeated = await syncT3Associations({
      statusClient: statusClient([attachment()]),
      indexPath,
      cataloguePath,
      localT3StatePath: join(root, "missing-t3.db"),
      resolveCwd: (cwd) => cwd,
    });
    expect(repeated.tagged).toBe(0);

    const empty = await syncT3Associations({
      statusClient: statusClient([]),
      indexPath,
      cataloguePath,
      localT3StatePath: join(root, "missing-t3.db"),
      resolveCwd: (cwd) => cwd,
    });
    expect(empty.tagged).toBe(0);
    const retained = openCatalogue(cataloguePath, { materialize: false });
    expect(getRow(retained, "canonical")?.t3Associated).toBeTrue();
    retained.close();

    const writeFailure = await syncT3Associations({
      statusClient: statusClient([attachment()]),
      indexPath,
      cataloguePath,
      localT3StatePath: join(root, "missing-t3.db"),
      resolveCwd: (cwd) => cwd,
      markAssociation: () => { throw new Error("database is locked"); },
      logger: { warn: () => undefined },
    });
    expect(writeFailure).toMatchObject({ status: "catalogue-unreadable", tagged: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
