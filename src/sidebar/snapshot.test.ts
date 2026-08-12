import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { getRow } from "../catalogue/db-queries.ts";
import { getIdentity, mintIdentity } from "../catalogue/identities.ts";
import { buildBridge, type Bridge } from "../cmux/bridge.ts";
import type { ResumeSessionResult } from "../resume/resume-session.ts";
import type { Launcher } from "../resume/launchers.ts";
import type {
  IndexedSessionInput,
  SidebarRow,
  SidebarSessionRow,
} from "./projection.ts";
import type { StoredEnrichment } from "../catalogue/enrichment.ts";
import type { CatalogueReadOutcome, CatalogueSnapshotFacts } from "./catalogue-read.ts";
import { createSidebarSource, type SidebarSourceOptions } from "./snapshot.ts";
import type { CmuxStatusRead } from "./status.ts";

/** Narrow to the session rows an assertion is about; sessionless workspaces carry no lifecycle. */
function sessionRows(rows: readonly SidebarRow[]): SidebarSessionRow[] {
  return rows.filter((row): row is SidebarSessionRow => row.kind === "session");
}

const LAUNCHERS: Launcher[] = [
  { name: "gateway", binary: "claude-gpt", serves: ["gpt-*"], env: {}, clears: [] },
];

const CANONICAL_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RESUME_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const SURFACE_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const WORKSPACE_ID = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";

function indexed(overrides: Partial<IndexedSessionInput> = {}): IndexedSessionInput {
  return {
    sessionId: "file-id",
    resumeId: "resume-id",
    title: "Indexed session",
    cwd: "/repo/default",
    lastTs: "2026-07-24T20:00:00.000Z",
    models: ["gpt-5.6-sol"],
    costByModel: {},
    ...overrides,
  };
}

function catalogueDb(rows: ReadonlyArray<{
  readonly sessionId: string;
  readonly resumeId?: string;
  readonly completed?: boolean;
  readonly saved?: boolean;
}> = []): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE catalogue (
      session_id TEXT PRIMARY KEY,
      resume_id TEXT,
      custom_title TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      saved INTEGER NOT NULL DEFAULT 0,
      parked_task_id TEXT,
      notes TEXT,
      updated_at TEXT,
      parent_session_id TEXT,
      meta TEXT,
      identity_key TEXT,
      substrate TEXT,
      launcher_identity TEXT,
      session_class TEXT,
      creator_kind TEXT,
      creator_ref TEXT,
      launch_channel TEXT,
      forked_from_session_id TEXT
    );
  `);
  const insert = db.query(
    `INSERT INTO catalogue (session_id, resume_id, completed, saved, updated_at)
     VALUES ($sessionId, $resumeId, $completed, $saved, '2026-07-24T20:00:00.000Z')`,
  );
  for (const row of rows) {
    insert.run({
      $sessionId: row.sessionId,
      $resumeId: row.resumeId ?? row.sessionId,
      $completed: row.completed ? 1 : 0,
      $saved: row.saved ? 1 : 0,
    });
  }
  return db;
}

function catalogueRead(rows: ReadonlyArray<{
  readonly sessionId: string;
  readonly resumeId?: string;
  readonly completed?: boolean;
  readonly saved?: boolean;
  readonly incognito?: boolean;
}> = []): CatalogueReadOutcome {
  const lifecycles = new Map<string, "active" | "completed" | "saved">();
  const catalogueLifecycles = new Map<string, "idle" | "completed" | "saved">();
  const canonicalSessionIds = new Map<string, string>();
  const sessionIds = new Map<"active" | "completed" | "saved", string[]>([
    ["active", []],
    ["completed", []],
    ["saved", []],
  ]);
  const incognito = new Set<string>();
  for (const row of rows) {
    const lifecycle = row.saved ? "saved" : row.completed ? "completed" : "active";
    lifecycles.set(row.sessionId, lifecycle);
    catalogueLifecycles.set(row.sessionId, lifecycle === "active" ? "idle" : lifecycle);
    canonicalSessionIds.set(row.sessionId, row.sessionId);
    if (row.incognito) {
      // Mirrors the real reader: marked rows keep their derived facts and stay out of the
      // per-lifecycle id lists.
      incognito.add(row.sessionId);
      if (row.resumeId) incognito.add(row.resumeId);
    } else {
      sessionIds.get(lifecycle)?.push(row.sessionId);
    }
  }
  for (const row of rows) {
    const resumeId = row.resumeId ?? row.sessionId;
    if (lifecycles.has(resumeId)) continue;
    lifecycles.set(resumeId, lifecycles.get(row.sessionId) ?? "active");
    catalogueLifecycles.set(resumeId, catalogueLifecycles.get(row.sessionId) ?? "idle");
    canonicalSessionIds.set(resumeId, row.sessionId);
  }
  const facts: CatalogueSnapshotFacts = {
    lifecycles,
    catalogueLifecycles,
    canonicalSessionIds,
    preferredTitles: new Map(),
    memberships: new Map(),
    sessionIds,
    auxiliary: new Set(),
    incognito,
    summaries: new Map(),
  };
  return { status: "ok", facts };
}

function pathDatabases(
  root: string,
  sessionCount: number,
  prefix: string,
): { readonly cataloguePath: string; readonly indexPath: string } {
  mkdirSync(root, { recursive: true });
  const cataloguePath = join(root, "catalogue.db");
  const catalogue = openCatalogue(cataloguePath, { materialize: false });
  try {
    const insert = catalogue.query(
      `INSERT INTO catalogue (session_id, resume_id, custom_title, updated_at)
       VALUES ($sessionId, $resumeId, $title, $updatedAt)`,
    );
    for (let index = 0; index < sessionCount; index += 1) {
      insert.run({
        $sessionId: `${prefix}-session-${index}`,
        $resumeId: `${prefix}-resume-${index}`,
        $title: `${prefix} title ${index}`,
        $updatedAt: new Date(Date.UTC(2026, 7, 5) - index * 60_000).toISOString(),
      });
    }
  } finally {
    catalogue.close();
  }

  const indexPath = join(root, "index.db");
  const indexDb = new Database(indexPath);
  try {
    indexDb.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        resume_id TEXT,
        cwd TEXT,
        last_ts TEXT,
        models TEXT,
        cost_by_model TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0,
        native_title TEXT
      );
    `);
    const insert = indexDb.query(
      `INSERT INTO sessions
         (session_id, resume_id, cwd, last_ts, models, cost_by_model, native_title)
       VALUES ($sessionId, $resumeId, $cwd, $lastTs, '[]', '{}', $title)`,
    );
    for (let row = 0; row < sessionCount; row += 1) {
      insert.run({
        $sessionId: `${prefix}-session-${row}`,
        $resumeId: `${prefix}-resume-${row}`,
        $cwd: join(root, `repo-${row}`),
        $lastTs: new Date(Date.UTC(2026, 7, 5) - row * 60_000).toISOString(),
        $title: `${prefix} title ${row}`,
      });
    }
  } finally {
    indexDb.close();
  }
  return { cataloguePath, indexPath };
}

function emptyBridge(readable = true): Bridge {
  return buildBridge({ windows: [] }, {}, readable);
}

function multiSurfaceBridge(): Bridge {
  return buildBridge(
    {
      windows: [{
        id: "window-uuid",
        ref: "window:1",
        workspaces: [{
          id: "workspace-uuid",
          ref: "workspace:7",
          title: "Shared workspace",
          panes: [{
            id: "pane-uuid",
            ref: "pane:1",
            index: 0,
            surfaces: [
              { id: "surface-primary", ref: "surface:1", index_in_pane: 0 },
              { id: "surface-secondary", ref: "surface:2", index_in_pane: 1 },
            ],
          }],
        }],
      }],
    },
    {
      sessions: {
        primary: {
          surfaceId: "surface-primary",
          workspaceId: "workspace-uuid",
          cwd: "/repo/primary",
          updatedAt: 1_700_000_000,
        },
        "secondary-resume-id": {
          surfaceId: "surface-secondary",
          workspaceId: "workspace-uuid",
          cwd: "/repo/secondary",
          updatedAt: 1_700_000_001,
        },
      },
    },
  );
}

function retireBridge(readable = true): Bridge {
  return buildBridge(
    {
      windows: [{
        id: "EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE",
        ref: "window:1",
        workspaces: [{
          id: WORKSPACE_ID,
          ref: "workspace:7",
          title: "Retiring",
          panes: [{
            id: "FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF",
            ref: "pane:1",
            index: 0,
            surfaces: [{ id: SURFACE_ID, ref: "surface:1", index_in_pane: 0 }],
          }],
        }],
      }],
    },
    {
      sessions: {
        [RESUME_SESSION_ID]: {
          surfaceId: SURFACE_ID,
          workspaceId: WORKSPACE_ID,
          cwd: "/repo/retiring",
        },
      },
    },
    readable,
  );
}

function sourceOptions(overrides: Partial<SidebarSourceOptions> = {}): SidebarSourceOptions {
  return {
    cmuxBin: "never-run-cmux",
    readBridge: async () => emptyBridge(),
    readStatuses: async () => new Map<string, CmuxStatusRead>(),
    processAdapter: {
      run: async () => ({ ok: true, stdout: "", stderr: "", timedOut: false }),
    },
    closeCmuxWorkspace: () => true,
    launchEnrichment: (sessionId) => ({
      ok: true,
      value: { logPath: `/runtime/enrich/${sessionId}.log` },
    }),
    loadLaunchers: () => ({ ok: true, value: LAUNCHERS }),
    resumeAction: async () => ({
      status: "ok",
      result: { status: "resumed", note: null, workspaceRef: "workspace:9" },
      paintRow: null,
    }),
    readCatalogue: () => catalogueRead(),
    ensureDataDir: () => {},
    indexedSessions: () => [indexed()],
    directoryFacts: {
      lookup: async () => ({ checkouts: new Map(), favicons: new Map() }),
    },
    ...overrides,
  };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      if (!resolvePromise) throw new Error("deferred promise was not initialized");
      resolvePromise(value);
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}

describe("createSidebarSource open", () => {
  test("single-flights canonical and resume-id requests so only one spawn can occur", async () => {
    const resumeResult = deferred<ResumeSessionResult>();
    let resumeCalls = 0;
    const source = createSidebarSource(sourceOptions({
      resumeAction: async () => {
        resumeCalls += 1;
        return {
          status: "ok",
          result: await resumeResult.promise,
          paintRow: null,
        };
      },
    }));

    const first = source.open("file-id");
    await waitFor(() => resumeCalls === 1);
    const duplicate = source.open("resume-id");
    await Promise.resolve();
    expect(resumeCalls).toBe(1);

    resumeResult.resolve({ status: "resumed", note: null, workspaceRef: "workspace:42" });

    await expect(first).resolves.toEqual({ status: "resumed", workspaceRef: "workspace:42" });
    await expect(duplicate).resolves.toEqual({ status: "focused", workspaceRef: "workspace:42" });
    expect(resumeCalls).toBe(1);
  });

  test("focuses the concrete workspace on a repeat click before SessionStart binds it", async () => {
    let current = 10_000;
    let resumeCalls = 0;
    const processCalls: string[][] = [];
    const source = createSidebarSource(sourceOptions({
      now: () => current,
      recentlyResumedMs: 500,
      processAdapter: {
        run: async (_file, args) => {
          processCalls.push([...args]);
          return { ok: true, stdout: "", stderr: "", timedOut: false };
        },
      },
      resumeAction: async () => {
        resumeCalls += 1;
        return {
          status: "ok",
          result: {
            status: "resumed",
            note: null,
            workspaceRef: `workspace:${resumeCalls}`,
          },
          paintRow: null,
        };
      },
    }));

    await expect(source.open("file-id")).resolves.toEqual({
      status: "resumed",
      workspaceRef: "workspace:1",
    });
    await expect(source.open("resume-id")).resolves.toEqual({
      status: "focused",
      workspaceRef: "workspace:1",
    });
    expect(resumeCalls).toBe(1);
    expect(processCalls).toEqual([
      ["select-workspace", "--workspace", "workspace:1"],
    ]);

    current += 501;
    await expect(source.open("file-id")).resolves.toEqual({
      status: "resumed",
      workspaceRef: "workspace:2",
    });
    expect(resumeCalls).toBe(2);
  });

  test("refuses to open anything when liveness is unreadable", async () => {
    let resumeCalls = 0;
    const source = createSidebarSource(sourceOptions({
      readBridge: async () => emptyBridge(false),
      indexedSessions: () => {
        throw new Error("the index must not be read");
      },
      resumeAction: async () => {
        resumeCalls += 1;
        return {
          status: "ok",
          result: { status: "resumed", note: null, workspaceRef: "workspace:1" },
          paintRow: null,
        };
      },
    }));

    await expect(source.open("file-id")).resolves.toEqual({ status: "liveness-unreadable" });
    expect(resumeCalls).toBe(0);
  });

  test("fails closed when launcher configuration cannot be loaded", async () => {
    let resumeCalls = 0;
    const source = createSidebarSource(sourceOptions({
      loadLaunchers: () => ({ ok: false, error: new Error("config.toml is malformed") }),
      resumeAction: async () => {
        resumeCalls += 1;
        return {
          status: "ok",
          result: { status: "resumed", note: null, workspaceRef: "workspace:1" },
          paintRow: null,
        };
      },
    }));

    await expect(source.open("file-id")).resolves.toEqual({
      status: "failed",
      reason: "launcher configuration could not be loaded: config.toml is malformed",
    });
    expect(resumeCalls).toBe(0);
  });

  test("reads one fresh Bridge and uses one command for a workspace in the active window", async () => {
    const bridge = buildBridge(
      {
        active: { window_id: "window-id" },
        windows: [{
          id: "window-id",
          ref: "window:4",
          workspaces: [{
            id: "workspace-id",
            ref: "workspace:8",
            title: "Live",
            panes: [{
              id: "pane-id",
              ref: "pane:1",
              index: 0,
              surfaces: [{ id: "surface-id", ref: "surface:1", index_in_pane: 0 }],
            }],
          }],
        }],
      },
      { sessions: { "file-id": { surfaceId: "surface-id", workspaceId: "workspace-id", cwd: "/repo" } } },
    );
    let bridgeReads = 0;
    const processCalls: string[][] = [];
    const source = createSidebarSource(sourceOptions({
      readBridge: async () => {
        bridgeReads += 1;
        return bridge;
      },
      indexedSessions: () => {
        throw new Error("direct live focus must not touch the synchronous index");
      },
      processAdapter: {
        run: async (_file, args) => {
          processCalls.push([...args]);
          return { ok: true, stdout: "", stderr: "", timedOut: false };
        },
      },
    }));

    await expect(source.open("file-id")).resolves.toEqual({
      status: "focused",
      workspaceRef: "workspace:8",
    });
    expect(bridgeReads).toBe(1);
    expect(processCalls).toEqual([
      ["select-workspace", "--workspace", "workspace:8"],
    ]);
  });

  test("opens the oldest row in a 250-row snapshot through its resume alias", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-old-row-open-"));
    try {
      const paths = pathDatabases(directory, 250, "history");
      let bridgeReads = 0;
      const resumedSessionIds: string[] = [];
      const source = createSidebarSource({
        ...paths,
        cmuxBin: "never-run-cmux",
        readBridge: async () => {
          bridgeReads += 1;
          return emptyBridge();
        },
        readStatuses: async () => new Map<string, CmuxStatusRead>(),
        processAdapter: {
          run: async () => ({ ok: true, stdout: "", stderr: "", timedOut: false }),
        },
        loadLaunchers: () => ({ ok: true, value: LAUNCHERS }),
        resumeAction: async ({ sessionId }) => {
          resumedSessionIds.push(sessionId);
          return {
            status: "ok",
            result: { status: "resumed", note: null, workspaceRef: "workspace:oldest" },
            paintRow: null,
          };
        },
        directoryFacts: {
          lookup: async () => ({ checkouts: new Map(), favicons: new Map() }),
        },
      });

      const snapshot = await source.snapshot("active", 250);
      const rows = sessionRows(snapshot.rows);
      expect(rows).toHaveLength(250);
      expect(rows.at(-1)?.sessionId).toBe("history-session-249");
      const bridgeReadsBeforeOpen = bridgeReads;

      await expect(source.open("history-resume-249")).resolves.toEqual({
        status: "resumed",
        workspaceRef: "workspace:oldest",
      });
      expect(resumedSessionIds).toEqual(["history-session-249"]);
      expect(bridgeReads - bridgeReadsBeforeOpen).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps explicit window targeting for a workspace in a background window", async () => {
    const bridge = buildBridge(
      {
        active: { window_id: "active-window-id" },
        windows: [{
          id: "background-window-id",
          ref: "window:4",
          workspaces: [{
            id: "workspace-id",
            ref: "workspace:8",
            title: "Live",
            panes: [{
              id: "pane-id",
              ref: "pane:1",
              index: 0,
              surfaces: [{ id: "surface-id", ref: "surface:1", index_in_pane: 0 }],
            }],
          }],
        }],
      },
      { sessions: { "file-id": { surfaceId: "surface-id", workspaceId: "workspace-id", cwd: "/repo" } } },
    );
    const processCalls: string[][] = [];
    const source = createSidebarSource(sourceOptions({
      readBridge: async () => bridge,
      processAdapter: {
        run: async (_file, args) => {
          processCalls.push([...args]);
          return { ok: true, stdout: "", stderr: "", timedOut: false };
        },
      },
    }));

    await expect(source.open("file-id")).resolves.toEqual({
      status: "focused",
      workspaceRef: "workspace:8",
    });
    expect(processCalls).toEqual([
      ["select-workspace", "--workspace", "workspace:8", "--window", "window:4"],
      ["focus-window", "--window", "window:4"],
    ]);
  });

  test("keeps snapshots responsive while real-shaped focus commands are pending", async () => {
    const processGate = deferred<void>();
    const bridge = buildBridge(
      {
        active: { window_id: "window-id" },
        windows: [{
          id: "window-id",
          ref: "window:4",
          workspaces: [
            {
              id: "workspace-one",
              ref: "workspace:8",
              title: "Live one",
              panes: [{
                id: "pane-one",
                ref: "pane:1",
                index: 0,
                surfaces: [{ id: "surface-one", ref: "surface:1", index_in_pane: 0 }],
              }],
            },
            {
              id: "workspace-two",
              ref: "workspace:9",
              title: "Live two",
              panes: [{
                id: "pane-two",
                ref: "pane:2",
                index: 0,
                surfaces: [{ id: "surface-two", ref: "surface:2", index_in_pane: 0 }],
              }],
            },
          ],
        }],
      },
      {
        sessions: {
          "file-id": { surfaceId: "surface-one", workspaceId: "workspace-one", cwd: "/repo" },
          "other-id": { surfaceId: "surface-two", workspaceId: "workspace-two", cwd: "/repo" },
        },
      },
    );
    const processCalls: string[][] = [];
    const source = createSidebarSource(sourceOptions({
      readBridge: async () => bridge,
      processAdapter: {
        run: async (_file, args) => {
          processCalls.push([...args]);
          await processGate.promise;
          return { ok: true, stdout: "", stderr: "", timedOut: false };
        },
      },
    }));

    const firstOpening = source.open("file-id");
    const secondOpening = source.open("other-id");
    await waitFor(() => processCalls.length === 2);
    expect(processCalls).toEqual([
      ["select-workspace", "--workspace", "workspace:8"],
      ["select-workspace", "--workspace", "workspace:9"],
    ]);

    const snapshotStartedAt = performance.now();
    await expect(source.snapshot()).resolves.toMatchObject({ livenessReadable: true });
    expect(performance.now() - snapshotStartedAt).toBeLessThan(50);

    processGate.resolve(undefined);
    await expect(firstOpening).resolves.toEqual({ status: "focused", workspaceRef: "workspace:8" });
    await expect(secondOpening).resolves.toEqual({ status: "focused", workspaceRef: "workspace:9" });
  });

  test("defers cosmetic paint from the already-read row and ignores paint failure", async () => {
    const deferredTasks: Array<() => void> = [];
    const paintedRows: string[] = [];
    const paintDb = catalogueDb([{ sessionId: "file-id" }]);
    const paintRow = getRow(paintDb, "file-id");
    paintDb.close();
    const source = createSidebarSource(sourceOptions({
      resumeAction: async () => ({
        status: "ok",
        result: { status: "resumed", note: null, workspaceRef: "workspace:9" },
        paintRow,
      }),
      deferActionTask: (task) => deferredTasks.push(task),
      paintWorkspace: async (row) => {
        paintedRows.push(row.sessionId);
        throw new Error("paint unavailable");
      },
    }));

    await expect(source.open("file-id")).resolves.toEqual({
      status: "resumed",
      workspaceRef: "workspace:9",
    });
    expect(deferredTasks).toHaveLength(1);
    expect(paintedRows).toEqual([]);
    deferredTasks[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(paintedRows).toEqual(["file-id"]);
  });

  test("keeps absent and unreadable liveness as distinct typed outcomes", async () => {
    const absent = createSidebarSource(sourceOptions({ indexedSessions: () => [] }));
    await expect(absent.open("missing")).resolves.toEqual({ status: "not-found" });

    const unreadable = createSidebarSource(sourceOptions({
      readBridge: async () => emptyBridge(false),
      indexedSessions: () => [],
    }));
    await expect(unreadable.open("missing")).resolves.toEqual({
      status: "liveness-unreadable",
    });
  });
});

describe("createSidebarSource lifecycle", () => {
  test("applies complete, save, unsave, and uncomplete without changing other flags", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-lifecycle-"));
    const dbPath = join(directory, "catalogue.db");
    try {
      const setup = openCatalogue(dbPath);
      const identityKey = "sidebar:worker:session-1";
      mintIdentity(setup, identityKey, { cluster: "sidebar", role: "worker" }, "2026-07-24T20:00:00.000Z");
      setup.query(
        "INSERT INTO catalogue (session_id, identity_key) VALUES ('session-1', $identityKey)",
      ).run({ $identityKey: identityKey });
      setup.close();

      const source = createSidebarSource(sourceOptions({
        cataloguePath: dbPath,
      }));
      const identityLifecycle = (): { readonly completed: boolean; readonly saved: boolean } => {
        const db = openCatalogue(dbPath);
        try {
          const identity = getIdentity(db, identityKey);
          if (!identity) throw new Error("test identity disappeared");
          return { completed: identity.completed, saved: identity.saved };
        } finally {
          db.close();
        }
      };

      await expect(source.setLifecycle("session-1", "complete")).resolves.toEqual({
        status: "ok",
        lifecycle: "completed",
      });
      expect(identityLifecycle()).toEqual({ completed: true, saved: false });
      await expect(source.setLifecycle("session-1", "save")).resolves.toEqual({
        status: "ok",
        lifecycle: "saved",
      });
      expect(identityLifecycle()).toEqual({ completed: false, saved: true });
      await expect(source.setLifecycle("session-1", "unsave")).resolves.toEqual({
        status: "ok",
        lifecycle: "active",
      });
      expect(identityLifecycle()).toEqual({ completed: false, saved: false });
      await expect(source.setLifecycle("session-1", "complete")).resolves.toEqual({
        status: "ok",
        lifecycle: "completed",
      });
      await expect(source.setLifecycle("session-1", "uncomplete")).resolves.toEqual({
        status: "ok",
        lifecycle: "active",
      });
      expect(identityLifecycle()).toEqual({ completed: false, saved: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps lifecycle per-session when the attached identity is core", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-lifecycle-core-"));
    const dbPath = join(directory, "catalogue.db");
    try {
      const identityKey = "sidebar:control";
      const setup = openCatalogue(dbPath);
      mintIdentity(setup, identityKey, { cluster: "sidebar", role: "control" }, "2026-07-24T20:00:00.000Z");
      setup.query(
        "INSERT INTO catalogue (session_id, identity_key) VALUES ('core-session', $identityKey)",
      ).run({ $identityKey: identityKey });
      setup.close();

      const source = createSidebarSource(sourceOptions({
        cataloguePath: dbPath,
      }));
      await expect(source.setLifecycle("core-session", "save")).resolves.toEqual({
        status: "ok",
        lifecycle: "saved",
      });

      const check = openCatalogue(dbPath);
      try {
        expect(getIdentity(check, identityKey)?.saved).toBeFalse();
      } finally {
        check.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses to mutate a session absent from the catalogue", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-lifecycle-missing-"));
    const dbPath = join(directory, "catalogue.db");
    try {
      const setup = openCatalogue(dbPath);
      setup.close();
      const source = createSidebarSource(sourceOptions({
        cataloguePath: dbPath,
      }));

      await expect(source.setLifecycle("missing-session", "complete")).resolves.toEqual({
        status: "not-found",
      });

      const check = openCatalogue(dbPath);
      try {
        expect(check.query(
          "SELECT session_id FROM catalogue WHERE session_id = 'missing-session'",
        ).get()).toBeNull();
      } finally {
        check.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("complete runs lifecycle, detached enrichment, two proofs, then stable-UUID close", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-retire-"));
    const dbPath = join(directory, "catalogue.db");
    const events: string[] = [];
    try {
      const setup = openCatalogue(dbPath);
      setup.query(
        "INSERT INTO catalogue (session_id, resume_id) VALUES ($sessionId, $resumeId)",
      ).run({ $sessionId: CANONICAL_SESSION_ID, $resumeId: RESUME_SESSION_ID });
      setup.close();

      const source = createSidebarSource(sourceOptions({
        cataloguePath: dbPath,
        indexedSessions: () => [indexed({
          sessionId: CANONICAL_SESSION_ID,
          resumeId: RESUME_SESSION_ID,
        })],
        readBridge: async () => {
          events.push("bridge");
          return retireBridge();
        },
        launchEnrichment: (sessionId) => {
          events.push(`enrich:${sessionId}`);
          return { ok: true, value: { logPath: `/runtime/enrich/${sessionId}.log` } };
        },
        closeCmuxWorkspace: (workspaceId, windowRef, cmuxBin) => {
          events.push(`close:${workspaceId}:${windowRef}:${cmuxBin}`);
          return true;
        },
      }));

      await expect(source.retire(CANONICAL_SESSION_ID, "complete")).resolves.toEqual({
        status: "ok",
        lifecycle: "completed",
      });
      expect(events).toEqual([
        `enrich:${CANONICAL_SESSION_ID}`,
        "bridge",
        "bridge",
        `close:${WORKSPACE_ID}:window:1:never-run-cmux`,
      ]);

      const check = openCatalogue(dbPath);
      try {
        expect(getRow(check, CANONICAL_SESSION_ID)?.completed).toBeTrue();
      } finally {
        check.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports closeFailed after a successful lifecycle write", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-retire-close-failed-"));
    const dbPath = join(directory, "catalogue.db");
    try {
      const setup = openCatalogue(dbPath);
      setup.query(
        "INSERT INTO catalogue (session_id, resume_id) VALUES ($sessionId, $resumeId)",
      ).run({ $sessionId: CANONICAL_SESSION_ID, $resumeId: RESUME_SESSION_ID });
      setup.close();

      const source = createSidebarSource(sourceOptions({
        cataloguePath: dbPath,
        indexedSessions: () => [indexed({
          sessionId: CANONICAL_SESSION_ID,
          resumeId: RESUME_SESSION_ID,
        })],
        readBridge: async () => retireBridge(),
        closeCmuxWorkspace: () => false,
      }));

      await expect(source.retire(CANONICAL_SESSION_ID, "save")).resolves.toEqual({
        status: "ok",
        lifecycle: "saved",
        closeFailed: "cmux refused to close the workspace after CCS authorized it",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uncomplete remains lifecycle-only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-uncomplete-"));
    const dbPath = join(directory, "catalogue.db");
    const events: string[] = [];
    try {
      const setup = openCatalogue(dbPath);
      setup.query(
        "INSERT INTO catalogue (session_id, completed) VALUES ($sessionId, 1)",
      ).run({ $sessionId: CANONICAL_SESSION_ID });
      setup.close();

      const source = createSidebarSource(sourceOptions({
        cataloguePath: dbPath,
        readBridge: async () => {
          events.push("bridge");
          return retireBridge();
        },
        launchEnrichment: (sessionId) => {
          events.push(`enrich:${sessionId}`);
          return { ok: true, value: { logPath: `/runtime/enrich/${sessionId}.log` } };
        },
        closeCmuxWorkspace: () => {
          events.push("close");
          return true;
        },
      }));

      await expect(source.retire(CANONICAL_SESSION_ID, "uncomplete")).resolves.toEqual({
        status: "ok",
        lifecycle: "active",
      });
      expect(events).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("createSidebarSource snapshot", () => {
  test("never opens or materializes the catalogue through a writer path", async () => {
    let mutationCalls = 0;
    let dataDirectoryWrites = 0;
    const source = createSidebarSource(sourceOptions({
      lifecycleCommand: () => {
        mutationCalls += 1;
        return { status: "catalogue-unreadable" };
      },
      ensureDataDir: () => {
        dataDirectoryWrites += 1;
      },
      readCatalogue: () => catalogueRead([{ sessionId: "file-id" }]),
    }));

    await source.snapshot();

    expect(mutationCalls).toBe(0);
    expect(dataDirectoryWrites).toBe(0);
  });

  test("uses explicit index and catalogue paths for snapshots and actions when CCS_ROOT differs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-custom-paths-"));
    const previousRoot = process.env.CCS_ROOT;
    try {
      const globalRoot = join(directory, "global-root");
      const globalPaths = pathDatabases(join(globalRoot, "cache"), 1, "global");
      const customPaths = pathDatabases(join(directory, "custom"), 1, "custom");
      process.env.CCS_ROOT = globalRoot;
      const resumedSessionIds: string[] = [];
      const source = createSidebarSource({
        ...customPaths,
        cmuxBin: "never-run-cmux",
        readBridge: async () => emptyBridge(),
        readStatuses: async () => new Map<string, CmuxStatusRead>(),
        notificationReader: {
          read: async () => ({ notifications: [], unreadCountsByWorkspaceId: new Map() }),
        },
        processAdapter: {
          run: async () => ({ ok: true, stdout: "", stderr: "", timedOut: false }),
        },
        loadLaunchers: () => ({ ok: true, value: LAUNCHERS }),
        resumeAction: async ({ sessionId }) => {
          resumedSessionIds.push(sessionId);
          return {
            status: "ok",
            result: { status: "resumed", note: null, workspaceRef: "workspace:custom" },
            paintRow: null,
          };
        },
        ensureDataDir: () => {},
        directoryFacts: {
          lookup: async () => ({ checkouts: new Map(), favicons: new Map() }),
        },
      });

      const snapshot = await source.snapshot("active", 20);
      expect(snapshot.indexReadable).toBeTrue();
      expect(snapshot.catalogueReadable).toBeTrue();
      expect(sessionRows(snapshot.rows).map((row) => row.sessionId)).toEqual(["custom-session-0"]);

      await expect(source.open("custom-resume-0")).resolves.toEqual({
        status: "resumed",
        workspaceRef: "workspace:custom",
      });
      expect(resumedSessionIds).toEqual(["custom-session-0"]);
      await expect(source.setLifecycle("custom-session-0", "complete")).resolves.toEqual({
        status: "ok",
        lifecycle: "completed",
      });

      const customCatalogue = openCatalogue(customPaths.cataloguePath, { materialize: false });
      const globalCatalogue = openCatalogue(globalPaths.cataloguePath, { materialize: false });
      try {
        expect(getRow(customCatalogue, "custom-session-0")?.completed).toBeTrue();
        expect(getRow(globalCatalogue, "global-session-0")?.completed).toBeFalse();
      } finally {
        customCatalogue.close();
        globalCatalogue.close();
      }
    } finally {
      if (previousRoot === undefined) delete process.env.CCS_ROOT;
      else process.env.CCS_ROOT = previousRoot;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses stable workspace ids and never shelves a live secondary surface", async () => {
    const statusTargets: string[][] = [];
    const source = createSidebarSource(sourceOptions({
      readBridge: async () => multiSurfaceBridge(),
      indexedSessions: () => [
        indexed({ sessionId: "primary", resumeId: "primary", cwd: "/repo/primary" }),
        indexed({
          sessionId: "secondary-file-id",
          resumeId: "secondary-resume-id",
          title: "Secondary pane",
          cwd: "/repo/secondary",
        }),
      ],
      readStatuses: async (workspaceIds) => {
        statusTargets.push([...workspaceIds]);
        return new Map([["workspace-uuid", { state: "absent" }]]);
      },
    }));

    const snapshot = await source.snapshot();

    expect(statusTargets).toEqual([["workspace-uuid"]]);
    expect(sessionRows(snapshot.rows).map((row) => row.sessionId)).toEqual(["primary"]);
    expect(snapshot.rows[0]).toMatchObject({
      workspaceRef: "workspace:7",
      status: null,
      statusAvailability: "absent",
      section: "ready",
    });
  });

  test("equal warm-cache refreshes keep the serialized snapshot stable", async () => {
    let clock = 100;
    let statusReads = 0;
    const source = createSidebarSource(sourceOptions({
      now: () => clock,
      readBridge: async () => multiSurfaceBridge(),
      readStatuses: async () => {
        statusReads += 1;
        return new Map<string, CmuxStatusRead>([[
          "workspace-uuid",
          { state: "published", status: { label: "Running", icon: null, color: null } },
        ]]);
      },
      notificationReader: {
        read: async () => ({ notifications: [], unreadCountsByWorkspaceId: new Map() }),
      },
    }));

    const first = await source.snapshot();
    clock += 2_500;
    const stale = await source.snapshot();
    expect(stale).toEqual(first);
    await waitFor(() => statusReads === 2);
    await Promise.resolve();
    await Promise.resolve();

    const refreshed = await source.snapshot();
    expect(refreshed).toEqual(first);
    expect(statusReads).toBe(2);
  });

  test("publishes a catalogue id that the lifecycle endpoint can mutate for a live resume alias", async () => {
    const mutated: string[] = [];
    const source = createSidebarSource(sourceOptions({
      readBridge: async () => multiSurfaceBridge(),
      indexedSessions: () => [
        indexed({ sessionId: "canonical-primary", resumeId: "primary", cwd: "/repo/primary" }),
      ],
      lifecycleCommand: (sessionId) => {
        mutated.push(sessionId);
        return { status: "ok", value: "completed" };
      },
      readCatalogue: () => catalogueRead([{
        sessionId: "canonical-primary",
        resumeId: "primary",
      }]),
      readStatuses: async () => new Map([[
        "workspace-uuid",
        { state: "absent" },
      ]]),
    }));

    const row = sessionRows((await source.snapshot()).rows)[0];
    expect(row?.sessionId).toBe("canonical-primary");
    await expect(source.setLifecycle(row!.sessionId, "complete")).resolves.toEqual({
      status: "ok",
      lifecycle: "completed",
    });
    expect(mutated).toEqual(["canonical-primary"]);
  });

  test("joins catalogue lifecycle into active, completed, and saved scopes", async () => {
    const sessions = [
      indexed({ sessionId: "active", resumeId: "active", lastTs: "2026-07-24T22:00:00.000Z" }),
      indexed({ sessionId: "completed", resumeId: "completed", lastTs: "2026-07-24T21:00:00.000Z" }),
      indexed({ sessionId: "saved", resumeId: "saved", lastTs: "2026-07-24T20:00:00.000Z" }),
    ];
    const source = createSidebarSource(sourceOptions({
      indexedSessions: () => sessions,
      readCatalogue: () => catalogueRead([
        { sessionId: "active" },
        { sessionId: "completed", completed: true },
        { sessionId: "saved", saved: true },
      ]),
    }));

    expect(sessionRows((await source.snapshot()).rows).map((row) => [row.sessionId, row.lifecycle])).toEqual([
      ["active", "active"],
    ]);
    expect(sessionRows((await source.snapshot("completed")).rows).map((row) => [row.sessionId, row.lifecycle]))
      .toEqual([["completed", "completed"]]);
    expect(sessionRows((await source.snapshot("saved")).rows).map((row) => [row.sessionId, row.lifecycle]))
      .toEqual([["saved", "saved"]]);
  });

  test("degrades every visible row to active and reports an unreadable catalogue", async () => {
    const source = createSidebarSource(sourceOptions({
      readCatalogue: () => ({
        status: "unreadable",
        error: new Error("catalogue is locked"),
      }),
    }));

    const snapshot = await source.snapshot();

    expect(snapshot.catalogueReadable).toBeFalse();
    expect(snapshot.rows).toHaveLength(1);
    expect(sessionRows(snapshot.rows)[0]?.lifecycle).toBe("active");
  });

  for (const unavailable of [
    { status: "missing" as const },
    { status: "unreadable" as const, error: new Error("catalogue unreadable") },
  ]) {
    test(`keeps live rows when the catalogue is ${unavailable.status}`, async () => {
      const source = createSidebarSource(sourceOptions({
        readBridge: async () => multiSurfaceBridge(),
        readCatalogue: () => unavailable,
        readStatuses: async () => new Map([[
          "workspace-uuid",
          { state: "published", status: { label: "Running", icon: null, color: null } },
        ]]),
      }));

      const snapshot = await source.snapshot();

      expect(snapshot.catalogueReadable).toBeFalse();
      expect(sessionRows(snapshot.rows).map((row) => row.sessionId)).toContain("primary");
      expect(snapshot.rows[0]).toMatchObject({ lifecycle: "active", section: "working" });
    });
  }

  test("keeps a completed live session reachable when the index cannot be read", async () => {
    const source = createSidebarSource(sourceOptions({
      readBridge: async () => multiSurfaceBridge(),
      indexedSessions: () => {
        throw new Error("index unreadable");
      },
      readCatalogue: () => catalogueRead([{ sessionId: "primary", completed: true }]),
      readStatuses: async () => new Map([
        ["workspace-uuid", {
          state: "published",
          status: { label: "Running", icon: null, color: null },
        }],
      ]),
    }));

    const snapshot = await source.snapshot("completed");

    expect(snapshot.indexReadable).toBeFalse();
    expect(sessionRows(snapshot.rows).map((row) => row.sessionId)).toEqual(["primary"]);
    expect(snapshot.rows[0]).toMatchObject({
      lifecycle: "completed",
      workspaceRef: "workspace:7",
    });
  });

  test("keeps serving live rows when the session index cannot be read", async () => {
    // Another checkout can migrate the shared index to a newer schema than this build supports.
    // cmux alone still knows what is running, so the queue must survive that.
    const source = createSidebarSource(sourceOptions({
      readBridge: async () => multiSurfaceBridge(),
      indexedSessions: () => {
        throw new Error("index schema version 11 is newer than supported version 10");
      },
      readStatuses: async () => new Map([["workspace-uuid", { state: "published", status: { label: "Running", icon: null, color: null } }]]),
    }));

    const snapshot = await source.snapshot();

    expect(snapshot.indexReadable).toBe(false);
    expect(sessionRows(snapshot.rows).map((row) => row.sessionId)).toEqual(["primary"]);
    expect(snapshot.rows[0]).toMatchObject({ section: "working", model: null });
  });

  test("offers no resume shelf when the index is unreadable", async () => {
    const source = createSidebarSource(sourceOptions({
      indexedSessions: () => {
        throw new Error("index unreadable");
      },
    }));

    const snapshot = await source.snapshot();

    expect(snapshot.rows.filter((row) => row.section === "recent")).toEqual([]);
    expect(snapshot.indexReadable).toBe(false);
  });

  test("reports a readable index on the ordinary path", async () => {
    const snapshot = await createSidebarSource(sourceOptions()).snapshot();

    expect(snapshot.indexReadable).toBe(true);
    expect(snapshot.catalogueReadable).toBe(true);
  });

  test("authorizes favicons only for rows in the latest returned snapshot", async () => {
    const firstIndex = Array.from({ length: 9 }, (_, index) => indexed({
      sessionId: `session-${index}`,
      resumeId: `session-${index}`,
      title: `Session ${index}`,
      cwd: `/repo/${index}`,
    }));
    let snapshotNumber = 0;
    const source = createSidebarSource(sourceOptions({
      indexedSessions: () => snapshotNumber++ === 0 ? firstIndex : [firstIndex[8]!],
      directoryFacts: {
        lookup: async (directories) => ({
          checkouts: new Map(),
          favicons: new Map(directories.map((directory) => [directory, `${directory}/icon.png`])),
        }),
      },
    }));

    const first = await source.snapshot();
    expect(first.rows).toHaveLength(8);
    expect(source.faviconFor("/repo/0")).toBe("/repo/0/icon.png");
    expect(source.faviconFor("/repo/8")).toBeNull();

    const second = await source.snapshot();
    expect(second.rows.map((row) => row.directoryPath)).toEqual(["/repo/8"]);
    expect(source.faviconFor("/repo/0")).toBeNull();
    expect(source.faviconFor("/repo/8")).toBe("/repo/8/icon.png");
  });
});

function storedEnrichment(): StoredEnrichment {
  return {
    title: null, state: "Working", history: null, next: null, remaining: null,
    recommendation: null, reason: null, junk: false, cwdCorrect: null,
    suggestedLocation: null, suggestedCwd: null, atMessages: 2,
    at: "2026-08-10T00:00:00Z", legacyShape: false, declined: null,
  };
}

test("the exact-count pass stats live rows only, so a long tail costs nothing", async () => {
  // A stat per row is synchronous, so at four hundred rows this pass blocked the event loop for
  // seconds. A closed session cannot have typed since the index parsed it, so its count is already
  // final and reading it buys nothing.
  const statted: string[] = [];
  const summaries = new Map<string, StoredEnrichment>();
  const catalogueWithSummaries = (): CatalogueReadOutcome => {
    const outcome = catalogueRead([
      { sessionId: "primary" },
      { sessionId: "closed-one", completed: true },
    ]);
    if (outcome.status !== "ok") throw new Error("fixture catalogue must read");
    summaries.set("primary", storedEnrichment());
    summaries.set("closed-one", storedEnrichment());
    return { ...outcome, facts: { ...outcome.facts, summaries } };
  };

  const source = createSidebarSource(sourceOptions({
    readBridge: async () => multiSurfaceBridge(),
    readCatalogue: catalogueWithSummaries,
    indexedSessions: () => [
      indexed({ sessionId: "primary", resumeId: "primary", transcriptPath: "/transcripts/primary.jsonl" }),
      indexed({ sessionId: "closed-one", resumeId: "closed-one", transcriptPath: "/transcripts/closed-one.jsonl" }),
    ],
    readExactMessageCount: async (session) => {
      statted.push(session.transcriptPath ?? "unknown");
      return 1;
    },
  }));

  await source.snapshot("active", 50, ["completed"]);

  // "primary" is the bridge's live surface; "closed-one" exists only in the index.
  expect(statted).toEqual(["/transcripts/primary.jsonl"]);
});

describe("createSidebarSource incognito", () => {
  test("a closed marked session is absent; the same session open appears in its own section", async () => {
    const rows = [{ sessionId: RESUME_SESSION_ID, resumeId: RESUME_SESSION_ID, incognito: true }];
    const indexedRow = indexed({ sessionId: RESUME_SESSION_ID, resumeId: RESUME_SESSION_ID });

    // Closed: the whole point of the guarantee. Not shelved, not one flag away -- gone.
    const closed = createSidebarSource(sourceOptions({
      readCatalogue: () => catalogueRead(rows),
      indexedSessions: () => [indexedRow],
      readBridge: async () => emptyBridge(),
    }));
    const closedSnapshot = await closed.snapshot("active", 50);
    expect(closedSnapshot.rows.some((row) => row.id === RESUME_SESSION_ID)).toBeFalse();

    // Open: the same session, same mark, now visible -- and in the incognito section rather than
    // among the live status queues.
    const open = createSidebarSource(sourceOptions({
      readCatalogue: () => catalogueRead(rows),
      indexedSessions: () => [indexedRow],
      readBridge: async () => retireBridge(),
    }));
    const openSnapshot = await open.snapshot("active", 50);
    const openRow = openSnapshot.rows.find((row) => row.id === RESUME_SESSION_ID);
    expect(openRow).toBeDefined();
    expect(openRow?.section).toBe("incognito");
  });

  test("an unmarked session is untouched by any of this", async () => {
    const source = createSidebarSource(sourceOptions({
      readCatalogue: () => catalogueRead([{ sessionId: RESUME_SESSION_ID, resumeId: RESUME_SESSION_ID }]),
      indexedSessions: () => [indexed({ sessionId: RESUME_SESSION_ID, resumeId: RESUME_SESSION_ID })],
      readBridge: async () => retireBridge(),
    }));
    const snapshot = await source.snapshot("active", 50);
    const row = snapshot.rows.find((candidate) => candidate.id === RESUME_SESSION_ID);
    expect(row).toBeDefined();
    expect(row?.section).not.toBe("incognito");
  });
});
