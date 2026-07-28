import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../index/schema.ts";
import { CATALOGUE_SOURCE_STALE_AFTER_MS, checkCatalogueService } from "./check.ts";

const roots: string[] = [];
const bin = join(import.meta.dir, "..", "..", "bin", "ccs");

interface Fixture {
  readonly root: string;
  readonly configPath: string;
  readonly indexPath: string;
  readonly sourcePath: string;
  readonly env: Record<string, string>;
}

function fixture(sourceMtimeMs: number, indexedMtimeMs: number | null, createIndex = true): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ccs-catalogue-check-")));
  roots.push(root);
  const storePath = join(root, "claude", "projects");
  const projectPath = join(storePath, "project");
  const configPath = join(root, "config.toml");
  const indexPath = join(root, "cache", "index.db");
  const sourcePath = join(projectPath, "session.jsonl");
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(configPath, `[store]\npath = "${storePath}"\n`);
  writeFileSync(sourcePath, "metadata-only check\n");
  utimesSync(sourcePath, sourceMtimeMs / 1_000, sourceMtimeMs / 1_000);
  const sourceSizeBytes = statSync(sourcePath).size;

  if (createIndex) {
    mkdirSync(join(root, "cache"), { recursive: true });
    const db = openIndex(indexPath);
    try {
      if (indexedMtimeMs !== null) {
        db.query(
          `INSERT INTO sessions (
             session_id, host, path, project_root, project_name,
             fallback_label, file_mtime, file_size, resume_id
           ) VALUES (
             'session', 'test-host', $path, '/project', 'project',
             'Session', $mtime, $size, 'session'
           )`,
        ).run({ $path: sourcePath, $mtime: indexedMtimeMs, $size: sourceSizeBytes });
      }
      db.query(
        `UPDATE catalogue_source_status
         SET generation = 7,
             indexed_at = '2026-07-28T12:00:00.000Z',
             refreshed_at = '2026-07-28T12:05:00.000Z',
             last_error_at = '2026-07-28T11:00:00.000Z',
             last_error = 'previous diagnostic'
         WHERE singleton = 1`,
      ).run();
    } finally {
      db.close();
    }
  }

  return {
    root,
    configPath,
    indexPath,
    sourcePath,
    env: {
      ...process.env,
      CCS_ROOT: root,
      CCS_CATALOGUE_SOCKET: join(root, "service.sock"),
    },
  };
}

async function runCheck(f: Fixture): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([bin, "catalogue-service", "check", "--json"], {
    env: f.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a fresh source index is healthy while the on-demand service is idle", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const f = fixture(sourceMtimeMs, sourceMtimeMs - CATALOGUE_SOURCE_STALE_AFTER_MS);
  const report = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    lockPath: join(f.root, "missing.lock"),
    inspectService: () => ({ running: false, pid: null }),
  });

  expect(report.healthy).toBe(true);
  expect(report.service).toEqual({ running: false, pid: null });
  expect(report.sourceIndex).toEqual({
    state: "fresh",
    sourceLatestMtimeMs: sourceMtimeMs,
    indexedLatestMtimeMs: sourceMtimeMs - CATALOGUE_SOURCE_STALE_AFTER_MS,
    lagMs: CATALOGUE_SOURCE_STALE_AFTER_MS,
    staleAfterMs: CATALOGUE_SOURCE_STALE_AFTER_MS,
    sourceFiles: 1,
    indexedSessions: 1,
    outOfSyncSessions: 0,
    generation: 7,
    indexedAt: "2026-07-28T12:00:00.000Z",
    refreshedAt: "2026-07-28T12:05:00.000Z",
    lastErrorAt: "2026-07-28T11:00:00.000Z",
    lastError: "previous diagnostic",
  });
});

test("a newer smaller shadow duplicate does not make the canonical source look stale", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const f = fixture(sourceMtimeMs, sourceMtimeMs);
  const shadowPath = join(f.root, "claude", "projects", "shadow", "session.jsonl");
  mkdirSync(join(f.root, "claude", "projects", "shadow"), { recursive: true });
  writeFileSync(shadowPath, "x");
  utimesSync(
    shadowPath,
    (sourceMtimeMs + CATALOGUE_SOURCE_STALE_AFTER_MS + 1_000) / 1_000,
    (sourceMtimeMs + CATALOGUE_SOURCE_STALE_AFTER_MS + 1_000) / 1_000,
  );

  const report = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    inspectService: () => ({ running: false, pid: null }),
  });

  expect(report.healthy).toBe(true);
  expect(report.sourceIndex.sourceFiles).toBe(2);
  expect(report.sourceIndex.sourceLatestMtimeMs).toBe(sourceMtimeMs);
  expect(report.sourceIndex.lagMs).toBe(0);
});

test("a newly created session gets the freshness grace period before becoming stale", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const f = fixture(sourceMtimeMs, sourceMtimeMs);
  const newPath = join(f.root, "claude", "projects", "project", "new-session.jsonl");
  const newMtimeMs = sourceMtimeMs - 60 * 60 * 1_000;
  writeFileSync(newPath, "new session\n");
  utimesSync(newPath, newMtimeMs / 1_000, newMtimeMs / 1_000);

  const withinSla = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    nowMs: sourceMtimeMs,
    inspectService: () => ({ running: false, pid: null }),
  });
  expect(withinSla.healthy).toBe(true);
  expect(withinSla.sourceIndex.outOfSyncSessions).toBe(0);

  const beyondSla = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    nowMs: sourceMtimeMs + CATALOGUE_SOURCE_STALE_AFTER_MS + 1,
    inspectService: () => ({ running: false, pid: null }),
  });
  expect(beyondSla.healthy).toBe(false);
  expect(beyondSla.sourceIndex.state).toBe("stale");
  expect(beyondSla.sourceIndex.outOfSyncSessions).toBe(1);
});

test("an empty source and empty index are fresh", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const f = fixture(sourceMtimeMs, null);
  rmSync(f.sourcePath);

  const report = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    nowMs: sourceMtimeMs,
    inspectService: () => ({ running: false, pid: null }),
  });

  expect(report.healthy).toBe(true);
  expect(report.sourceIndex.state).toBe("fresh");
  expect(report.sourceIndex.sourceFiles).toBe(0);
  expect(report.sourceIndex.indexedSessions).toBe(0);
  expect(report.sourceIndex.outOfSyncSessions).toBe(0);
});

test("a populated source with an empty index is stale", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const f = fixture(sourceMtimeMs, null);

  const report = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    nowMs: sourceMtimeMs,
    inspectService: () => ({ running: false, pid: null }),
  });

  expect(report.healthy).toBe(false);
  expect(report.sourceIndex.state).toBe("stale");
  expect(report.sourceIndex.outOfSyncSessions).toBe(1);
});

test("a source rollback is structural drift even without positive lag", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const f = fixture(sourceMtimeMs, sourceMtimeMs + 1_000);

  const report = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    nowMs: sourceMtimeMs,
    inspectService: () => ({ running: false, pid: null }),
  });

  expect(report.healthy).toBe(false);
  expect(report.sourceIndex.lagMs).toBe(0);
  expect(report.sourceIndex.outOfSyncSessions).toBe(1);
});

test("a same-mtime size change is structural drift", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const f = fixture(sourceMtimeMs, sourceMtimeMs);
  writeFileSync(f.sourcePath, "metadata-only check with changed size\n");
  utimesSync(f.sourcePath, sourceMtimeMs / 1_000, sourceMtimeMs / 1_000);

  const report = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    nowMs: sourceMtimeMs,
    inspectService: () => ({ running: false, pid: null }),
  });

  expect(report.healthy).toBe(false);
  expect(report.sourceIndex.lagMs).toBe(0);
  expect(report.sourceIndex.outOfSyncSessions).toBe(1);
});

test("a lagging non-newest canonical session makes the index stale", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const f = fixture(sourceMtimeMs, sourceMtimeMs);
  const olderPath = join(f.root, "claude", "projects", "project", "older.jsonl");
  writeFileSync(olderPath, "older session\n");
  utimesSync(
    olderPath,
    (sourceMtimeMs - 60 * 60 * 1_000) / 1_000,
    (sourceMtimeMs - 60 * 60 * 1_000) / 1_000,
  );
  const db = openIndex(f.indexPath);
  try {
    db.query(
      `INSERT INTO sessions (
         session_id, host, path, project_root, project_name,
         fallback_label, file_mtime, file_size, resume_id
       ) VALUES (
         'older', 'test-host', $path, '/project', 'project',
         'Older', $mtime, 1, 'older'
       )`,
    ).run({ $path: olderPath, $mtime: sourceMtimeMs - 4 * 60 * 60 * 1_000 });
  } finally {
    db.close();
  }

  const report = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    nowMs: sourceMtimeMs,
    inspectService: () => ({ running: false, pid: null }),
  });

  expect(report.healthy).toBe(false);
  expect(report.sourceIndex.state).toBe("stale");
  expect(report.sourceIndex.lagMs).toBe(3 * 60 * 60 * 1_000);
  expect(report.sourceIndex.outOfSyncSessions).toBe(1);
});

test("an indexed session removed from the source makes the index stale", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const f = fixture(sourceMtimeMs, sourceMtimeMs);
  const db = openIndex(f.indexPath);
  try {
    db.query(
      `INSERT INTO sessions (
         session_id, host, path, project_root, project_name,
         fallback_label, file_mtime, file_size, resume_id
       ) VALUES (
         'deleted', 'test-host', '/missing/deleted.jsonl', '/project', 'project',
         'Deleted', $mtime, 1, 'deleted'
       )`,
    ).run({ $mtime: sourceMtimeMs + 60 * 60 * 1_000 });
  } finally {
    db.close();
  }

  const report = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    nowMs: sourceMtimeMs,
    inspectService: () => ({ running: false, pid: null }),
  });

  expect(report.healthy).toBe(false);
  expect(report.sourceIndex.state).toBe("stale");
  expect(report.sourceIndex.lagMs).toBe(0);
  expect(report.sourceIndex.outOfSyncSessions).toBe(1);
});

test("source lag beyond the two-hour SLA is stale even when the service is running", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const f = fixture(sourceMtimeMs, sourceMtimeMs - CATALOGUE_SOURCE_STALE_AFTER_MS - 1_000);
  const report = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    inspectService: () => ({ running: true, pid: 4321 }),
  });

  expect(report.healthy).toBe(false);
  expect(report.service).toEqual({ running: true, pid: 4321 });
  expect(report.sourceIndex.state).toBe("stale");
  expect(report.sourceIndex.lagMs).toBe(CATALOGUE_SOURCE_STALE_AFTER_MS + 1_000);
});

test("a missing readonly index is unavailable without reading transcript contents", async () => {
  const f = fixture(2_000_000_000_000, null, false);
  const report = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    inspectService: () => ({ running: false, pid: null }),
  });

  expect(report.healthy).toBe(false);
  expect(report.sourceIndex.state).toBe("unavailable");
  expect(report.sourceIndex.sourceFiles).toBe(1);
  expect(report.sourceIndex.sourceLatestMtimeMs).toBe(2_000_000_000_000);
  expect(report.sourceIndex.lastError).toContain("Cannot read catalogue index");
});

test("an unavailable source scan retains readonly index status diagnostics", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const f = fixture(sourceMtimeMs, sourceMtimeMs - 1_000);
  rmSync(join(f.root, "claude"), { recursive: true, force: true });

  const report = await checkCatalogueService({
    configPath: f.configPath,
    indexPath: f.indexPath,
    inspectService: () => ({ running: false, pid: null }),
  });

  expect(report.sourceIndex.state).toBe("unavailable");
  expect(report.sourceIndex.indexedSessions).toBe(1);
  expect(report.sourceIndex.generation).toBe(7);
  expect(report.sourceIndex.indexedAt).toBe("2026-07-28T12:00:00.000Z");
  expect(report.sourceIndex.lastErrorAt).toBe("2026-07-28T11:00:00.000Z");
  expect(report.sourceIndex.lastError).toContain("Failed to scan store");
  expect(report.sourceIndex.lastError).toContain("catalogue_source_status: previous diagnostic");
});

test("check --json preserves the contract and exits nonzero for stale or unavailable indexes", async () => {
  const sourceMtimeMs = 2_000_000_000_000;
  const fresh = fixture(sourceMtimeMs, sourceMtimeMs - 1_000);
  const stale = fixture(sourceMtimeMs, sourceMtimeMs - CATALOGUE_SOURCE_STALE_AFTER_MS - 1);
  const unavailable = fixture(sourceMtimeMs, null, false);

  const freshRun = await runCheck(fresh);
  expect(freshRun.exitCode).toBe(0);
  expect(freshRun.stderr).toBe("");
  const freshJson = JSON.parse(freshRun.stdout) as {
    healthy: boolean;
    service: { running: boolean; pid: number | null };
    sourceIndex: Record<string, string | number | boolean | null>;
  };
  expect(freshJson.healthy).toBe(true);
  expect(freshJson.service).toEqual({ running: false, pid: null });
  expect(Object.keys(freshJson.sourceIndex).sort()).toEqual([
    "generation",
    "indexedAt",
    "indexedLatestMtimeMs",
    "indexedSessions",
    "lagMs",
    "lastError",
    "lastErrorAt",
    "outOfSyncSessions",
    "refreshedAt",
    "sourceFiles",
    "sourceLatestMtimeMs",
    "staleAfterMs",
    "state",
  ]);

  expect((await runCheck(stale)).exitCode).toBe(1);
  expect((await runCheck(unavailable)).exitCode).toBe(1);
});
