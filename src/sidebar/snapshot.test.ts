import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRow, openCatalogue } from "../catalogue/db.ts";
import { getIdentity, mintIdentity } from "../catalogue/identities.ts";
import { buildBridge, type Bridge } from "../cmux/bridge.ts";
import type { ResumeSessionResult } from "../resume/resume-session.ts";
import type { Launcher } from "../resume/launchers.ts";
import type {
  IndexedSessionInput,
  SidebarRow,
  SidebarSessionRow,
} from "./projection.ts";
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
  readonly archived?: boolean;
}> = []): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE catalogue (
      session_id TEXT PRIMARY KEY,
      resume_id TEXT,
      custom_title TEXT,
      completed INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
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
    `INSERT INTO catalogue (session_id, resume_id, completed, archived, updated_at)
     VALUES ($sessionId, $resumeId, $completed, $archived, '2026-07-24T20:00:00.000Z')`,
  );
  for (const row of rows) {
    insert.run({
      $sessionId: row.sessionId,
      $resumeId: row.resumeId ?? row.sessionId,
      $completed: row.completed ? 1 : 0,
      $archived: row.archived ? 1 : 0,
    });
  }
  return db;
}

function catalogueRead(rows: ReadonlyArray<{
  readonly sessionId: string;
  readonly resumeId?: string;
  readonly completed?: boolean;
  readonly archived?: boolean;
}> = []): CatalogueReadOutcome {
  const lifecycles = new Map<string, "active" | "completed" | "archived">();
  const canonicalSessionIds = new Map<string, string>();
  const sessionIds = new Map<"active" | "completed" | "archived", string[]>([
    ["active", []],
    ["completed", []],
    ["archived", []],
  ]);
  for (const row of rows) {
    const lifecycle = row.archived ? "archived" : row.completed ? "completed" : "active";
    lifecycles.set(row.sessionId, lifecycle);
    canonicalSessionIds.set(row.sessionId, row.sessionId);
    sessionIds.get(lifecycle)?.push(row.sessionId);
  }
  for (const row of rows) {
    const resumeId = row.resumeId ?? row.sessionId;
    if (lifecycles.has(resumeId)) continue;
    lifecycles.set(resumeId, lifecycles.get(row.sessionId) ?? "active");
    canonicalSessionIds.set(resumeId, row.sessionId);
  }
  const facts: CatalogueSnapshotFacts = {
    lifecycles,
    canonicalSessionIds,
    preferredTitles: new Map(),
    memberships: new Map(),
    sessionIds,
    auxiliary: new Set(),
    summaries: new Map(),
  };
  return { status: "ok", facts };
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
    focus: () => true,
    closeCmuxWorkspace: () => true,
    launchEnrichment: (sessionId) => ({
      ok: true,
      value: { logPath: `/runtime/enrich/${sessionId}.log` },
    }),
    loadLaunchers: () => ({ ok: true, value: LAUNCHERS }),
    resumeSession: () => ({ status: "resumed", note: null, workspaceRef: "workspace:9" }),
    openIndex: () => new Database(":memory:"),
    openCatalogue: () => catalogueDb(),
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
      resumeSession: async () => {
        resumeCalls += 1;
        return resumeResult.promise;
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

  test("suppresses a repeat resume until the SessionStart binding window has elapsed", async () => {
    let current = 10_000;
    let resumeCalls = 0;
    const source = createSidebarSource(sourceOptions({
      now: () => current,
      recentlyResumedMs: 500,
      resumeSession: () => {
        resumeCalls += 1;
        return {
          status: "resumed",
          note: null,
          workspaceRef: `workspace:${resumeCalls}`,
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
      resumeSession: () => {
        resumeCalls += 1;
        return { status: "resumed", note: null, workspaceRef: "workspace:1" };
      },
    }));

    await expect(source.open("file-id")).resolves.toEqual({ status: "liveness-unreadable" });
    expect(resumeCalls).toBe(0);
  });

  test("fails closed when launcher configuration cannot be loaded", async () => {
    let resumeCalls = 0;
    const source = createSidebarSource(sourceOptions({
      loadLaunchers: () => ({ ok: false, error: new Error("config.toml is malformed") }),
      resumeSession: () => {
        resumeCalls += 1;
        return { status: "resumed", note: null, workspaceRef: "workspace:1" };
      },
    }));

    await expect(source.open("file-id")).resolves.toEqual({
      status: "failed",
      reason: "launcher configuration could not be loaded: config.toml is malformed",
    });
    expect(resumeCalls).toBe(0);
  });
});

describe("createSidebarSource lifecycle", () => {
  test("applies complete, archive, unarchive, and uncomplete without changing other flags", async () => {
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
        openCatalogue: () => openCatalogue(dbPath),
      }));
      const identityLifecycle = (): { readonly completed: boolean; readonly archived: boolean } => {
        const db = openCatalogue(dbPath);
        try {
          const identity = getIdentity(db, identityKey);
          if (!identity) throw new Error("test identity disappeared");
          return { completed: identity.completed, archived: identity.archived };
        } finally {
          db.close();
        }
      };

      await expect(source.setLifecycle("session-1", "complete")).resolves.toEqual({
        status: "ok",
        lifecycle: "completed",
      });
      expect(identityLifecycle()).toEqual({ completed: true, archived: false });
      await expect(source.setLifecycle("session-1", "archive")).resolves.toEqual({
        status: "ok",
        lifecycle: "archived",
      });
      expect(identityLifecycle()).toEqual({ completed: true, archived: true });
      await expect(source.setLifecycle("session-1", "unarchive")).resolves.toEqual({
        status: "ok",
        lifecycle: "completed",
      });
      expect(identityLifecycle()).toEqual({ completed: true, archived: false });
      await expect(source.setLifecycle("session-1", "uncomplete")).resolves.toEqual({
        status: "ok",
        lifecycle: "active",
      });
      expect(identityLifecycle()).toEqual({ completed: false, archived: false });
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
        openCatalogue: () => openCatalogue(dbPath),
      }));
      await expect(source.setLifecycle("core-session", "archive")).resolves.toEqual({
        status: "ok",
        lifecycle: "archived",
      });

      const check = openCatalogue(dbPath);
      try {
        expect(getIdentity(check, identityKey)?.archived).toBeFalse();
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
        openCatalogue: () => openCatalogue(dbPath),
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
        openCatalogue: () => openCatalogue(dbPath),
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
        openCatalogue: () => openCatalogue(dbPath),
        indexedSessions: () => [indexed({
          sessionId: CANONICAL_SESSION_ID,
          resumeId: RESUME_SESSION_ID,
        })],
        readBridge: async () => retireBridge(),
        closeCmuxWorkspace: () => false,
      }));

      await expect(source.retire(CANONICAL_SESSION_ID, "archive")).resolves.toEqual({
        status: "ok",
        lifecycle: "archived",
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
        openCatalogue: () => openCatalogue(dbPath),
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
    let writerOpens = 0;
    let dataDirectoryWrites = 0;
    const source = createSidebarSource(sourceOptions({
      openCatalogue: () => {
        writerOpens += 1;
        throw new Error("snapshot attempted a writer open");
      },
      ensureDataDir: () => {
        dataDirectoryWrites += 1;
      },
      readCatalogue: () => catalogueRead([{ sessionId: "file-id" }]),
    }));

    await source.snapshot();

    expect(writerOpens).toBe(0);
    expect(dataDirectoryWrites).toBe(0);
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

  test("publishes a catalogue id that the lifecycle endpoint can mutate for a live resume alias", async () => {
    const source = createSidebarSource(sourceOptions({
      readBridge: async () => multiSurfaceBridge(),
      indexedSessions: () => [
        indexed({ sessionId: "canonical-primary", resumeId: "primary", cwd: "/repo/primary" }),
      ],
      openCatalogue: () => catalogueDb([{
        sessionId: "canonical-primary",
        resumeId: "primary",
      }]),
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
  });

  test("joins catalogue lifecycle into active, completed, and archived scopes", async () => {
    const sessions = [
      indexed({ sessionId: "active", resumeId: "active", lastTs: "2026-07-24T22:00:00.000Z" }),
      indexed({ sessionId: "completed", resumeId: "completed", lastTs: "2026-07-24T21:00:00.000Z" }),
      indexed({ sessionId: "archived", resumeId: "archived", lastTs: "2026-07-24T20:00:00.000Z" }),
    ];
    const source = createSidebarSource(sourceOptions({
      indexedSessions: () => sessions,
      readCatalogue: () => catalogueRead([
        { sessionId: "active" },
        { sessionId: "completed", completed: true },
        { sessionId: "archived", archived: true },
      ]),
    }));

    expect(sessionRows((await source.snapshot()).rows).map((row) => [row.sessionId, row.lifecycle])).toEqual([
      ["active", "active"],
    ]);
    expect(sessionRows((await source.snapshot("completed")).rows).map((row) => [row.sessionId, row.lifecycle]))
      .toEqual([["completed", "completed"]]);
    expect(sessionRows((await source.snapshot("archived")).rows).map((row) => [row.sessionId, row.lifecycle]))
      .toEqual([["archived", "archived"]]);
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
