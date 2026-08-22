import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSidebarChangeMonitor } from "./change-monitor.ts";
import { createSidebarServer, isLoopbackSidebarHost } from "./server.ts";
import { refusalMessage, sidebarHttpError, type SidebarHttpErrorCode } from "./http-error.ts";
import { createSidebarSource } from "./snapshot.ts";
import { buildBridge, type Bridge } from "../cmux/bridge.ts";
import type { Launcher } from "../resume/launchers.ts";
import type { ResumeSessionResult } from "../resume/resume-session.ts";
import { createSnapshotLivenessReader } from "./liveness-cache.ts";
import type {
  OpenSessionOutcome,
  SessionLifecycleAction,
  SessionLifecycleOutcome,
  SidebarSource,
  CloseWorkspaceOutcome,
  FocusWorkspaceOutcome,
  PinWorkspaceOutcome,
} from "./snapshot.ts";
import {
  projectSidebar,
  type IndexedSessionInput,
  type SidebarLifecycle,
  type SidebarSnapshot,
  type SidebarView,
} from "./projection.ts";

const EMPTY_SNAPSHOT: SidebarSnapshot = {
  rows: [],
  livenessReadable: true,
  indexReadable: true,
  catalogueReadable: true,
  categoryProjectionVersion: 1,
  categoryProjectionError: null,
  lifecycleCounts: { active: 0, completed: 0, saved: 0 },
  hasMoreRows: false,
  generatedAt: 0,
};

const ASSETS = new Map([
  ["/index.html", { body: "<html>sidebar</html>", type: "text/html; charset=utf-8" }],
  ["/main.js", { body: "console.log(1)", type: "text/javascript; charset=utf-8" }],
]);

interface Harness {
  readonly url: string;
  readonly opened: string[];
  readonly diagnostics: Array<{
    readonly message: string;
    readonly context?: Record<string, unknown>;
  }>;
  readonly snapshotScopes: SidebarView[];
  readonly lifecycleChanges: Array<{
    readonly sessionId: string;
    readonly action: SessionLifecycleAction;
  }>;
  stop(): void;
}

const running: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not reached");
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolvePromise: ((value: T) => void) | null = null;
  let rejectPromise: ((error: Error) => void) | null = null;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value: T): void {
      if (resolvePromise === null) throw new Error("deferred promise was not initialized");
      resolvePromise(value);
    },
    reject(error: Error): void {
      if (rejectPromise === null) throw new Error("deferred promise was not initialized");
      rejectPromise(error);
    },
  };
}

function harness(
  overrides: Partial<SidebarSource> = {},
  snapshotRepresentationTtlMs?: number,
  snapshotRepresentationMaxBytes?: number,
): Harness {
  // Built below from the base source, so a test overriding setLifecycle still drives retire.
  const opened: string[] = [];
  const diagnostics: Array<{
    message: string;
    context?: Record<string, unknown>;
  }> = [];
  const snapshotScopes: SidebarView[] = [];
  const lifecycleChanges: Array<{
    readonly sessionId: string;
    readonly action: SessionLifecycleAction;
  }> = [];
  const source: Omit<SidebarSource, "retire"> & Partial<Pick<SidebarSource, "retire">> = {
    snapshot: async (scope = "active") => {
      snapshotScopes.push(scope);
      return EMPTY_SNAPSHOT;
    },
    declineSuggestion: async () => ({ status: "ok" as const }),
    setIncognito: async (_sessionId: string, incognito: boolean) => ({ status: "ok" as const, incognito }),
    destroyPreflight: async () => ({ status: "not-found" as const }),
    destroySession: async () => ({ status: "not-found" as const }),
    closeWorkspace: async (): Promise<CloseWorkspaceOutcome> => ({ status: "not-live" }),
    focusWorkspace: async (): Promise<FocusWorkspaceOutcome> => ({ status: "not-live" }),
    closeLooseWorkspace: async (): Promise<CloseWorkspaceOutcome> => ({ status: "not-live" }),
    setPinned: async (): Promise<PinWorkspaceOutcome> => ({ status: "not-live" }),

    open: async (sessionId: string): Promise<OpenSessionOutcome> => {
      opened.push(sessionId);
      return { status: "focused", workspaceRef: "workspace:1" };
    },
    setLifecycle: async (
      sessionId: string,
      action: SessionLifecycleAction,
    ): Promise<SessionLifecycleOutcome> => {
      lifecycleChanges.push({ sessionId, action });
      return { status: "ok", lifecycle: action === "save" ? "saved" : "completed" };
    },
    faviconFor: () => null,
    ...overrides,
  };

  // Port 0 lets the OS pick a free port so tests never collide with a real sidebar.
  // retire is setLifecycle plus a close, so the harness delegates the way production does and an
  // override of setLifecycle is still observed by the endpoint.
  const withRetire: SidebarSource = {
    ...source,
    retire: source.retire
      ?? ((sessionId: string, action: SessionLifecycleAction) =>
        source.setLifecycle(sessionId, action)),
  };
  const server = createSidebarServer({
    source: withRetire,
    assets: ASSETS,
    port: 0,
    logger: {
      warn(message, context): void {
        diagnostics.push({ message, ...(context === undefined ? {} : { context }) });
      },
    },
    ...(snapshotRepresentationTtlMs === undefined ? {} : { snapshotRepresentationTtlMs }),
    ...(snapshotRepresentationMaxBytes === undefined ? {} : { snapshotRepresentationMaxBytes }),
  });
  running.push(server);
  return {
    url: server.url.origin,
    opened,
    diagnostics,
    snapshotScopes,
    lifecycleChanges,
    stop: () => void server.stop(true),
  };
}

function postOpen(app: Harness, origin: string | null): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return fetch(`${app.url}/api/open`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId: "abc" }),
  });
}

async function expectHttpError(response: Response, code: SidebarHttpErrorCode): Promise<void> {
  const { status, ...envelope } = sidebarHttpError(code);
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(envelope);
}

async function expectActionHttpError(
  response: Response,
  code: SidebarHttpErrorCode,
  legacyStatus: "not-found" | "failed",
  /** The refusal code, when there was one; clients render a sentence from it. */
  refusal?: string,
): Promise<void> {
  const { status, ...envelope } = sidebarHttpError(code);
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({
    ...envelope,
    status: legacyStatus,
    ...(refusal === undefined ? {} : { refusal }),
  });
}

function postLifecycle(
  app: Harness,
  origin: string | null,
  body: string = JSON.stringify({ sessionId: "abc", action: "save" }),
  host?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  if (host !== undefined) headers.host = host;
  return fetch(`${app.url}/api/session/lifecycle`, {
    method: "POST",
    headers,
    body,
  });
}

afterEach(() => {
  while (running.length > 0) running.pop()?.stop(true);
});

describe("sidebar server", () => {
  test("serves the page at the root", async () => {
    const app = harness();
    const response = await fetch(`${app.url}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("<html>sidebar</html>");
  });

  test("serves bundled assets", async () => {
    const app = harness();
    const response = await fetch(`${app.url}/main.js`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log(1)");
  });

  test("returns the snapshot as json", async () => {
    const app = harness();
    const response = await fetch(`${app.url}/api/snapshot`);

    expect(response.status).toBe(200);
    // The transport stamps which release is answering; a repo checkout stamps "dev".
    expect(await response.json()).toEqual({
      ...EMPTY_SNAPSHOT,
      serverVersion: "dev",
      snapshotRevision: 0,
    });
    expect(app.snapshotScopes).toEqual(["active"]);
  });

  test("returns a strong ETag, then answers a warm 304 without rebuilding the snapshot", async () => {
    let snapshotCalls = 0;
    const app = harness({
      snapshot: async () => {
        snapshotCalls += 1;
        return EMPTY_SNAPSHOT;
      },
    });
    const first = await fetch(`${app.url}/api/snapshot`);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    await first.arrayBuffer();

    const unchanged = await fetch(`${app.url}/api/snapshot`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(unchanged.status).toBe(304);
    expect((await unchanged.arrayBuffer()).byteLength).toBe(0);
    expect(snapshotCalls).toBe(1);
  });

  test("returns 304 promptly while a requested liveness refresh is pending", async () => {
    const pending = deferred<Bridge>();
    let bridgeReads = 0;
    const liveness = createSnapshotLivenessReader({
      ttlMs: 60_000,
      readBridge: async () => {
        bridgeReads += 1;
        return bridgeReads === 1
          ? buildBridge({ windows: [] }, {}, true)
          : pending.promise;
      },
    });
    const app = harness({
      refreshSnapshotLiveness: () => liveness.refresh(),
      snapshot: async () => ({
        ...EMPTY_SNAPSHOT,
        livenessReadable: (await liveness.read()).readable,
      }),
    });
    const first = await fetch(`${app.url}/api/snapshot`);
    const etag = first.headers.get("etag") ?? "";
    await first.arrayBuffer();

    const startedAt = performance.now();
    const unchanged = await fetch(`${app.url}/api/snapshot`, {
      headers: {
        "if-none-match": etag,
        "x-ccs-refresh-liveness": "1",
      },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(unchanged.status).toBe(304);
    expect((await unchanged.arrayBuffer()).byteLength).toBe(0);
    expect(elapsedMs).toBeLessThan(50);
    expect(bridgeReads).toBe(2);
    pending.resolve(buildBridge({ windows: [] }, {}, true));
  });

  test("bridge-style refresh drops only its exact cached query and awaits a fresh snapshot", async () => {
    let activeCount = 0;
    let snapshotCalls = 0;
    let livenessRefreshes = 0;
    const app = harness({
      refreshSnapshotLiveness: () => {
        livenessRefreshes += 1;
      },
      snapshot: async (scope = "active") => {
        snapshotCalls += 1;
        return {
          ...EMPTY_SNAPSHOT,
          lifecycleCounts: {
            ...EMPTY_SNAPSHOT.lifecycleCounts,
            active: scope === "active" ? activeCount : 0,
          },
        };
      },
    });
    const active = await fetch(`${app.url}/api/snapshot?scope=active`);
    const activeEtag = active.headers.get("etag") ?? "";
    await active.arrayBuffer();
    const completed = await fetch(`${app.url}/api/snapshot?scope=completed`);
    const completedEtag = completed.headers.get("etag") ?? "";
    await completed.arrayBuffer();

    activeCount = 1;
    const refreshed = await fetch(`${app.url}/api/snapshot?scope=active`, {
      headers: {
        "if-none-match": activeEtag,
        "x-ccs-refresh-liveness": "1",
      },
    });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ lifecycleCounts: { active: 1 } });
    expect(livenessRefreshes).toBe(1);
    expect(snapshotCalls).toBe(3);

    const completedStillWarm = await fetch(`${app.url}/api/snapshot?scope=completed`, {
      headers: { "if-none-match": completedEtag },
    });
    expect(completedStillWarm.status).toBe(304);
    expect(snapshotCalls).toBe(3);
  });

  test("an advancing production clock does not turn an unchanged projection into 200", async () => {
    let current = 1_000;
    const app = harness({
      snapshot: async () => projectSidebar({
        live: [],
        indexed: [],
        checkouts: new Map(),
        livenessReadable: true,
        now: current++,
      }),
    });
    const first = await fetch(`${app.url}/api/snapshot`);
    const firstBody = await first.text();
    const etag = first.headers.get("etag") ?? "";
    expect(JSON.parse(firstBody)).toMatchObject({ generatedAt: 0 });

    const second = await fetch(`${app.url}/api/snapshot`, {
      headers: { "if-none-match": etag },
    });
    expect(second.status).toBe(304);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
  });

  test("coalesces one stale refresh and serves its changed representation on the next request", async () => {
    const pending = deferred<SidebarSnapshot>();
    let snapshotCalls = 0;
    const app = harness({
      snapshot: async () => {
        snapshotCalls += 1;
        if (snapshotCalls === 1) return EMPTY_SNAPSHOT;
        return pending.promise;
      },
    }, 0);
    const first = await fetch(`${app.url}/api/snapshot`);
    const etag = first.headers.get("etag") ?? "";
    await first.arrayBuffer();

    const [staleOne, staleTwo] = await Promise.all([
      fetch(`${app.url}/api/snapshot`, { headers: { "if-none-match": etag } }),
      fetch(`${app.url}/api/snapshot`, { headers: { "if-none-match": etag } }),
    ]);
    expect(staleOne.status).toBe(304);
    expect(staleTwo.status).toBe(304);
    expect(snapshotCalls).toBe(2);

    pending.resolve({
      ...EMPTY_SNAPSHOT,
      lifecycleCounts: { ...EMPTY_SNAPSHOT.lifecycleCounts, active: 1 },
    });
    await Bun.sleep(1);

    const changed = await fetch(`${app.url}/api/snapshot`, {
      headers: { "if-none-match": etag },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(await changed.json()).toMatchObject({ lifecycleCounts: { active: 1 } });
  });

  test("a failed stale rebuild leaves the previous valid representation usable", async () => {
    let snapshotCalls = 0;
    const app = harness({
      snapshot: async () => {
        snapshotCalls += 1;
        if (snapshotCalls > 1) throw new Error("transient snapshot failure");
        return EMPTY_SNAPSHOT;
      },
    }, 0);
    const first = await fetch(`${app.url}/api/snapshot`);
    const etag = first.headers.get("etag") ?? "";
    await first.arrayBuffer();

    const stale = await fetch(`${app.url}/api/snapshot`, {
      headers: { "if-none-match": etag },
    });
    expect(stale.status).toBe(304);
    await Bun.sleep(1);

    const retained = await fetch(`${app.url}/api/snapshot`, {
      headers: { "if-none-match": etag },
    });
    expect(retained.status).toBe(304);
    expect((await retained.arrayBuffer()).byteLength).toBe(0);
  });

  test("successful actions invalidate cached representations before the forced load", async () => {
    let snapshotCalls = 0;
    let activeCount = 0;
    const app = harness({
      snapshot: async () => {
        snapshotCalls += 1;
        return {
          ...EMPTY_SNAPSHOT,
          lifecycleCounts: { ...EMPTY_SNAPSHOT.lifecycleCounts, active: activeCount },
        };
      },
      setLifecycle: async () => {
        activeCount = 1;
        return { status: "ok", lifecycle: "completed" };
      },
    });
    const first = await fetch(`${app.url}/api/snapshot`);
    const etag = first.headers.get("etag") ?? "";
    await first.arrayBuffer();

    expect((await postLifecycle(app, app.url)).status).toBe(200);
    const forced = await fetch(`${app.url}/api/snapshot`, {
      headers: {
        "if-none-match": etag,
        "x-ccs-refresh-liveness": "1",
      },
    });
    expect(forced.status).toBe(200);
    expect(snapshotCalls).toBe(2);
    expect(await forced.json()).toMatchObject({ lifecycleCounts: { active: 1 } });
  });

  test("keeps snapshot representations isolated by exact query", async () => {
    const calls: Array<{
      readonly scope: SidebarView;
      readonly limit: number | undefined;
      readonly include: readonly SidebarLifecycle[];
    }> = [];
    const app = harness({
      snapshot: async (scope = "active", limit, include = []) => {
        calls.push({ scope, limit, include });
        return EMPTY_SNAPSHOT;
      },
    });

    await (await fetch(`${app.url}/api/snapshot?scope=active&limit=20`)).arrayBuffer();
    await (await fetch(`${app.url}/api/snapshot?scope=active&limit=20`)).arrayBuffer();
    await (await fetch(`${app.url}/api/snapshot?scope=completed&limit=20`)).arrayBuffer();
    await (await fetch(`${app.url}/api/snapshot?scope=active&limit=21`)).arrayBuffer();
    await (await fetch(`${app.url}/api/snapshot?scope=active&limit=20&include=completed`)).arrayBuffer();

    expect(calls).toEqual([
      { scope: "active", limit: 20, include: [] },
      { scope: "completed", limit: 20, include: [] },
      { scope: "active", limit: 21, include: [] },
      { scope: "active", limit: 20, include: ["completed"] },
    ]);
  });

  test("bounds exact-query representations and evicts the least recently used", async () => {
    let snapshotCalls = 0;
    const app = harness({
      snapshot: async () => {
        snapshotCalls += 1;
        return EMPTY_SNAPSHOT;
      },
    });

    for (let limit = 20; limit <= 36; limit += 1) {
      await (await fetch(`${app.url}/api/snapshot?limit=${limit}`)).arrayBuffer();
    }
    expect(snapshotCalls).toBe(17);

    await (await fetch(`${app.url}/api/snapshot?limit=20`)).arrayBuffer();
    expect(snapshotCalls).toBe(18);
  });

  test("bounds total serialized representation bytes with deterministic LRU eviction", async () => {
    const cacheTestPayload = "x".repeat(256);
    const snapshot = { ...EMPTY_SNAPSHOT, cacheTestPayload };
    const oneRepresentationBytes = Buffer.byteLength(JSON.stringify(snapshot));
    let snapshotCalls = 0;
    const app = harness({
      snapshot: async () => {
        snapshotCalls += 1;
        return snapshot;
      },
    }, undefined, (oneRepresentationBytes * 2) - 1);

    await (await fetch(`${app.url}/api/snapshot?limit=20`)).arrayBuffer();
    await (await fetch(`${app.url}/api/snapshot?limit=21`)).arrayBuffer();
    expect(snapshotCalls).toBe(2);

    // The second body crossed the byte budget and evicted the least-recently-used first query.
    await (await fetch(`${app.url}/api/snapshot?limit=20`)).arrayBuffer();
    expect(snapshotCalls).toBe(3);
    // The just-rebuilt first query evicted the second in turn, proving deterministic byte LRU.
    await (await fetch(`${app.url}/api/snapshot?limit=21`)).arrayBuffer();
    expect(snapshotCalls).toBe(4);
  });

  test("byte-identical projections share a strong ETag across query shapes", async () => {
    const app = harness();
    const first = await fetch(`${app.url}/api/snapshot?scope=active&limit=20`);
    const etag = first.headers.get("etag") ?? "";
    await first.arrayBuffer();

    for (const query of [
      "scope=completed&limit=20",
      "scope=active&limit=21",
      "scope=active&limit=20&include=completed",
    ]) {
      const unchanged = await fetch(`${app.url}/api/snapshot?${query}`, {
        headers: { "if-none-match": etag },
      });
      expect(unchanged.status).toBe(304);
      expect((await unchanged.arrayBuffer()).byteLength).toBe(0);
    }
  });

  test("passes a valid view and rejects an unknown one", async () => {
    const app = harness();

    const completed = await fetch(`${app.url}/api/snapshot?scope=completed`);
    expect(completed.status).toBe(200);
    expect(app.snapshotScopes).toEqual(["completed"]);

    // Triage is a view rather than a lifecycle, so it has to pass validation that the catalogue's
    // own three states would reject.
    const triage = await fetch(`${app.url}/api/snapshot?scope=triage`);
    expect(triage.status).toBe(200);
    expect(app.snapshotScopes).toEqual(["completed", "triage"]);

    const invalid = await fetch(`${app.url}/api/snapshot?scope=parked`);
    await expectHttpError(invalid, "bad_request");
    expect(app.snapshotScopes).toEqual(["completed", "triage"]);
  });

  test("reports a snapshot failure instead of serving a partial page", async () => {
    const app = harness({ snapshot: async () => { throw new Error("cmux is down"); } });
    const response = await fetch(`${app.url}/api/snapshot`);

    await expectHttpError(response, "internal_failure");
  });

  test("allows an open request from the bound same origin", async () => {
    const app = harness();
    const response = await postOpen(app, app.url);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "focused" });
    expect(app.opened).toEqual(["abc"]);
  });

  test("single-flights simultaneous open requests through the server and action coordinator", async () => {
    const session: IndexedSessionInput = {
      sessionId: "file-id",
      resumeId: "resume-id",
      title: "Indexed session",
      cwd: "/repo/default",
      lastTs: "2026-08-05T20:00:00.000Z",
      models: ["gpt-5.6-sol"],
      costByModel: {},
    };
    const launchers: Launcher[] = [
      { name: "gateway", binary: "claude-gpt", serves: ["gpt-*"], env: {}, clears: [] },
    ];
    const resumeResult = deferred<ResumeSessionResult>();
    let bridgeReads = 0;
    let resumeCalls = 0;
    const processCalls: string[][] = [];
    const source = createSidebarSource({
      cmuxBin: "never-run-cmux",
      readBridge: async () => {
        bridgeReads += 1;
        return buildBridge({ windows: [] }, {}, true);
      },
      indexedSessions: () => [session],
      loadLaunchers: () => ({ ok: true, value: launchers }),
      resumeAction: async () => {
        resumeCalls += 1;
        return { status: "ok", result: await resumeResult.promise, paintRow: null };
      },
      processAdapter: {
        run: async (_file, args) => {
          processCalls.push([...args]);
          return { ok: true, stdout: "", stderr: "", timedOut: false };
        },
      },
    });
    const server = createSidebarServer({ source, assets: ASSETS, port: 0 });
    running.push(server);
    const url = server.url.origin;
    const requests = Array.from({ length: 8 }, () => fetch(`${url}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ sessionId: session.sessionId }),
    }));

    await waitFor(() => resumeCalls === 1);
    // Keep the primitive pending long enough for every simultaneous HTTP request to enter the
    // server. The old resume-only guard performed eight Bridge reads here before coalescing late.
    await Bun.sleep(25);
    expect(bridgeReads).toBe(1);
    expect(resumeCalls).toBe(1);

    resumeResult.resolve({ status: "resumed", note: null, workspaceRef: "workspace:42" });
    const responses = await Promise.all(requests);
    const bodies = await Promise.all(responses.map(async (response) =>
      (await response.json()) as { readonly status: string; readonly workspaceRef: string }
    ));

    expect(responses.every((response) => response.status === 200)).toBeTrue();
    expect(bodies.filter((body) => body.status === "resumed")).toHaveLength(1);
    expect(bodies.filter((body) => body.status === "focused")).toHaveLength(7);
    expect(bodies.every((body) => body.workspaceRef === "workspace:42")).toBeTrue();
    expect(resumeCalls).toBe(1);
    expect(bridgeReads).toBe(1);
    expect(processCalls).toHaveLength(7);

    const repeat = await fetch(`${url}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    expect(await repeat.json()).toEqual({ status: "focused", workspaceRef: "workspace:42" });
    expect(resumeCalls).toBe(1);
    expect(bridgeReads).toBe(2);
    expect(processCalls).toHaveLength(8);
  });

  test("does not expose source error details from an open failure", async () => {
    const app = harness({
      open: async () => {
        throw new Error("failed at /private/catalogue.db");
      },
    });
    const response = await postOpen(app, app.url);

    await expectHttpError(response, "internal_failure");
    expect(app.diagnostics).toEqual([{
      message: "sidebar open request failed",
      context: { sessionId: "abc", error: "failed at /private/catalogue.db" },
    }]);
  });

  test("maps typed action failures to stable structured envelopes", async () => {
    const cases: ReadonlyArray<{
      readonly outcome: OpenSessionOutcome;
      readonly code: SidebarHttpErrorCode;
    }> = [
      { outcome: { status: "not-found" }, code: "not_found" },
      { outcome: { status: "liveness-unreadable" }, code: "liveness_unreadable" },
      { outcome: { status: "index-unreadable" }, code: "index_unreadable" },
      { outcome: { status: "catalogue-unreadable" }, code: "catalogue_unreadable" },
      { outcome: { status: "timeout" }, code: "timeout" },
      { outcome: { status: "failed", reason: "/private/raw failure" }, code: "action_failed" },
    ];

    for (const entry of cases) {
      const app = harness({ open: async () => entry.outcome });
      await expectActionHttpError(
        await postOpen(app, app.url),
        entry.code,
        entry.outcome.status === "not-found" ? "not-found" : "failed",
        undefined,
      );
      expect(app.diagnostics).toEqual([{
        message: "sidebar action failed",
        context: {
          operation: "open",
          sessionId: "abc",
          status: entry.outcome.status,
          ...(entry.outcome.status === "failed" ? { reason: entry.outcome.reason } : {}),
        },
      }]);
    }
  });

  test("rejects an open request with no session id", async () => {
    const app = harness();
    const response = await fetch(`${app.url}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(app.opened).toEqual([]);
  });

  test("refuses an open request from a foreign origin", async () => {
    const app = harness();
    const response = await postOpen(app, "https://evil.example");

    expect(response.status).toBe(403);
    expect(app.opened).toEqual([]);
  });

  test("refuses an open request with no Origin header", async () => {
    const app = harness();
    const response = await postOpen(app, null);

    expect(response.status).toBe(403);
    expect(app.opened).toEqual([]);
  });

  test("updates lifecycle from the bound same origin and returns the typed outcome", async () => {
    const app = harness();
    const response = await postLifecycle(app, app.url);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", lifecycle: "saved" });
    expect(app.lifecycleChanges).toEqual([{ sessionId: "abc", action: "save" }]);
  });

  test("passes through not-found without mutating an unknown session", async () => {
    const app = harness({
      setLifecycle: async () => ({ status: "not-found" }),
    });
    const response = await postLifecycle(app, app.url);

    await expectActionHttpError(response, "not_found", "not-found");
  });

  test("old lifecycle clients roll back optimistic state against the structured server", async () => {
    for (const outcome of [
      { status: "not-found" as const },
      { status: "failed" as const, reason: "/private/catalogue.db could not be written" },
    ]) {
      const app = harness({ setLifecycle: async () => outcome });
      const response = await postLifecycle(app, app.url);
      const legacyResult = (await response.json()) as { status?: string };
      let optimistic = true;

      // This is the pre-Phase-4 lifecycle discriminator: both branches call its revert closure.
      if (legacyResult.status === "failed" || legacyResult.status === "not-found") optimistic = false;

      expect(optimistic).toBeFalse();
      expect(legacyResult).not.toHaveProperty("reason");
      expect(JSON.stringify(legacyResult)).not.toContain("/private/catalogue.db");
    }
  });

  test("a close refusal names itself without leaking the reason it was logged with", async () => {
    // The two halves must not be confused: the code is a fixed token safe to show, the reason is
    // free text that has carried absolute paths.
    const app = harness({
      closeWorkspace: async () => ({
        status: "failed",
        reason: "ccs refused to close the workspace (/private/state.db says shared-workspace)",
        refusal: "shared-workspace",
      }),
    });

    const response = await fetch(`${app.url}/api/session/close`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ sessionId: "abc" }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(body.refusal).toBe("shared-workspace");
    expect(body).not.toHaveProperty("reason");
    expect(JSON.stringify(body)).not.toContain("/private/state.db");
    expect(refusalMessage("shared-workspace")).toContain("shares this workspace");
  });

  test("SQLite mutation failures reach diagnostics but not lifecycle or decline envelopes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-http-sqlite-failure-"));
    const diagnostics: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger = {
      warn(message: string, context?: Record<string, unknown>): void {
        diagnostics.push({ message, ...(context === undefined ? {} : { context }) });
      },
    };
    try {
      const source = createSidebarSource({
        cataloguePath: directory,
        ensureDataDir: (): void => {},
        logger,
      });
      const server = createSidebarServer({ source, assets: ASSETS, port: 0, logger });
      running.push(server);
      const url = server.url.origin;

      const lifecycle = await fetch(`${url}/api/session/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: url },
        body: JSON.stringify({ sessionId: "concrete-lifecycle", action: "unsave" }),
      });
      const lifecycleBody = await lifecycle.text();
      expect(lifecycle.status).toBe(503);
      expect(JSON.parse(lifecycleBody)).toEqual({
        code: "catalogue_unreadable",
        message: sidebarHttpError("catalogue_unreadable").message,
        retryable: true,
        status: "failed",
      });

      const decline = await fetch(`${url}/api/session/decline`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: url },
        body: JSON.stringify({ sessionId: "concrete-decline", verb: "archive" }),
      });
      const declineBody = await decline.text();
      expect(decline.status).toBe(503);
      expect(JSON.parse(declineBody)).toEqual({
        code: "catalogue_unreadable",
        message: sidebarHttpError("catalogue_unreadable").message,
        retryable: true,
        status: "failed",
      });

      expect(lifecycleBody).not.toContain(directory);
      expect(declineBody).not.toContain(directory);
      const lifecycleDiagnostic = diagnostics.find((entry) =>
        entry.message === "sidebar lifecycle catalogue mutation failed");
      expect(lifecycleDiagnostic).toMatchObject({
        context: {
          operation: "lifecycle",
          sessionId: "concrete-lifecycle",
          action: "unsave",
          cataloguePath: directory,
          error: "unable to open database file",
        },
      });
      const declineDiagnostic = diagnostics.find((entry) =>
        entry.message === "sidebar recommendation catalogue mutation failed");
      expect(declineDiagnostic).toMatchObject({
        context: {
          operation: "decline-recommendation",
          sessionId: "concrete-decline",
          recommendation: "archive",
          cataloguePath: directory,
          error: "unable to open database file",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("resume index open failures reach diagnostics but not the HTTP envelope", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-http-resume-failure-"));
    const diagnostics: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger = {
      warn(message: string, context?: Record<string, unknown>): void {
        diagnostics.push({ message, ...(context === undefined ? {} : { context }) });
      },
    };
    const bridge: Bridge = {
      surfaces: [],
      surfaceToWorkspace: new Map(),
      workspaceIds: () => [],
      surfacesInWorkspace: () => [],
      surfaceInfo: () => null,
      readable: true,
      locateSession: () => null,
      isOpen: () => false,
      primarySurface: () => null,
      activeWindowId: null,
    };
    try {
      const source = createSidebarSource({
        indexPath: directory,
        cataloguePath: join(directory, "unused-catalogue.db"),
        indexedSessions: () => [{
          sessionId: "abc",
          resumeId: "abc",
          title: "Concrete resume",
          cwd: directory,
          lastTs: null,
          models: [],
          costByModel: {},
        }],
        readBridge: async () => bridge,
        loadLaunchers: () => ({ ok: true as const, value: [] }),
        logger,
      });
      const server = createSidebarServer({ source, assets: ASSETS, port: 0, logger });
      running.push(server);
      const url = server.url.origin;

      const response = await postOpen({
        url,
        opened: [],
        diagnostics,
        snapshotScopes: [],
        lifecycleChanges: [],
        stop: () => void server.stop(true),
      }, url);
      const body = await response.text();

      expect(response.status).toBe(503);
      expect(JSON.parse(body)).toEqual({
        code: "index_unreadable",
        message: sidebarHttpError("index_unreadable").message,
        retryable: true,
        status: "failed",
      });
      expect(body).not.toContain(directory);
      const diagnostic = diagnostics.find((entry) => entry.message === "sidebar resume index open failed");
      expect(diagnostic).toMatchObject({
        context: {
          operation: "resume",
          sessionId: "abc",
          indexPath: directory,
          error: "unable to open database file",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses lifecycle changes from a missing or foreign Origin", async () => {
    const app = harness();

    expect((await postLifecycle(app, null)).status).toBe(403);
    expect((await postLifecycle(app, "https://evil.example")).status).toBe(403);
    expect(app.lifecycleChanges).toEqual([]);
  });

  test("rejects lifecycle bodies with missing, invalid, or unknown fields", async () => {
    const app = harness();
    const bodies = [
      JSON.stringify({ action: "complete" }),
      JSON.stringify({ sessionId: "abc" }),
      JSON.stringify({ sessionId: "abc", action: "park" }),
      JSON.stringify({ sessionId: "abc", action: "complete", extra: true }),
      "not json",
    ];

    for (const body of bodies) {
      expect((await postLifecycle(app, app.url, body)).status).toBe(400);
    }
    expect(app.lifecycleChanges).toEqual([]);
  });

  test("validates Host before lifecycle mutation", async () => {
    const app = harness();
    const response = await postLifecycle(
      app,
      app.url,
      JSON.stringify({ sessionId: "abc", action: "complete" }),
      "rebound.attacker.example",
    );

    await expectHttpError(response, "denied");
    expect(app.lifecycleChanges).toEqual([]);
  });

  test("validates Host before exposing GET endpoints", async () => {
    let snapshotCalls = 0;
    const app = harness({
      snapshot: async () => {
        snapshotCalls += 1;
        return EMPTY_SNAPSHOT;
      },
    });
    const response = await fetch(`${app.url}/api/snapshot`, {
      headers: { host: "rebound.attacker.example" },
    });

    await expectHttpError(response, "denied");
    expect(snapshotCalls).toBe(0);
  });

  test("accepts only literal loopback bind addresses", () => {
    const source: SidebarSource = {
      snapshot: async () => EMPTY_SNAPSHOT,
      declineSuggestion: async () => ({ status: "ok" as const }),
      setIncognito: async (_sessionId: string, incognito: boolean) => ({ status: "ok" as const, incognito }),
      destroyPreflight: async () => ({ status: "not-found" as const }),
      destroySession: async () => ({ status: "not-found" as const }),
      open: async () => ({ status: "not-found" }),
      setLifecycle: async () => ({ status: "not-found" }),
      closeWorkspace: async () => ({ status: "not-live" }),
      focusWorkspace: async () => ({ status: "not-live" as const }),
      closeLooseWorkspace: async () => ({ status: "not-live" as const }),
      setPinned: async () => ({ status: "not-live" as const }),
      retire: async () => ({ status: "not-found" }),
      faviconFor: () => null,
    };

    expect(isLoopbackSidebarHost("127.0.0.1")).toBeTrue();
    expect(isLoopbackSidebarHost("127.24.5.9")).toBeTrue();
    expect(isLoopbackSidebarHost("::1")).toBeTrue();
    expect(isLoopbackSidebarHost("localhost")).toBeFalse();
    expect(() => createSidebarServer({ source, assets: ASSETS, port: 0, hostname: "0.0.0.0" }))
      .toThrow("sidebar host must be a literal loopback address");
  });

  test("serves only an icon from a directory the source published", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-favicon-"));
    try {
      const icon = join(directory, "favicon.png");
      writeFileSync(icon, "not-really-a-png");
      const app = harness({ faviconFor: (asked) => (asked === directory ? icon : null) });

      const allowed = await fetch(`${app.url}/api/favicon?dir=${encodeURIComponent(directory)}`);
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("content-type")).toBe("image/png");
      expect(allowed.headers.get("x-content-type-options")).toBe("nosniff");
      expect(allowed.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");

      const denied = await fetch(`${app.url}/api/favicon?dir=${encodeURIComponent("/etc")}`);
      expect(denied.status).toBe(404);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses a favicon replaced by a symlink after the snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-favicon-swap-"));
    try {
      const icon = join(directory, "favicon.png");
      const secret = join(directory, "secret.txt");
      writeFileSync(icon, "original icon");
      writeFileSync(secret, "secret bytes");
      const app = harness({ faviconFor: (asked) => (asked === directory ? icon : null) });

      expect((await fetch(`${app.url}/api/snapshot`)).status).toBe(200);
      unlinkSync(icon);
      symlinkSync(secret, icon);

      const response = await fetch(`${app.url}/api/favicon?dir=${encodeURIComponent(directory)}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("secret bytes");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses SVG even when the source previously selected it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-favicon-svg-"));
    try {
      const icon = join(directory, "favicon.svg");
      writeFileSync(icon, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const app = harness({ faviconFor: (asked) => (asked === directory ? icon : null) });

      const response = await fetch(`${app.url}/api/favicon?dir=${encodeURIComponent(directory)}`);
      expect(response.status).toBe(404);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("falls back to the page for unknown routes but not for asset paths", async () => {
    const app = harness();

    expect((await fetch(`${app.url}/anything`)).status).toBe(200);
    expect((await fetch(`${app.url}/missing.js`)).status).toBe(404);
  });
});

describe("slow snapshot diagnostics", () => {
  test("the warning carries the phase breakdown and the loop lag", async () => {
    const app = harness({
      snapshot: async (_scope, _limit, _include, observe) => {
        // A slow request whose cost is entirely in one phase: the whole point of the breakdown is
        // that the log can say which.
        observe?.({
          view: "active",
          rowCount: 0,
          totalMs: 420,
          phases: {
            bridgeMs: 400,
            catalogueMs: 5,
            indexMs: 6,
            statusMs: 7,
            workspaceStateMs: 8,
            messageCountMs: 11,
            directoryFactsMs: 9,
            notificationsMs: 10,
            projectionMs: 2,
          },
          livenessReadable: true,
          catalogueReadable: true,
          indexReadable: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
        return EMPTY_SNAPSHOT;
      },
    });

    expect((await fetch(`${app.url}/api/snapshot`)).status).toBe(200);

    const slow = app.diagnostics.find((entry) => entry.message === "slow sidebar snapshot request");
    expect(slow).toBeDefined();
    expect(slow?.context).toMatchObject({
      sourceMs: 420,
      bridgeMs: 400,
      catalogueMs: 5,
      indexMs: 6,
      statusMs: 7,
      workspaceStateMs: 8,
      messageCountMs: 11,
      directoryFactsMs: 9,
      notificationsMs: 10,
      projectionMs: 2,
    });
    expect(typeof slow?.context?.eventLoopLagMs).toBe("number");
    expect(slow?.context?.eventLoopLagMs as number).toBeGreaterThanOrEqual(0);
  });

  test("a source that reports nothing still logs, with the phases absent rather than wrong", async () => {
    const app = harness({
      snapshot: async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return EMPTY_SNAPSHOT;
      },
    });

    expect((await fetch(`${app.url}/api/snapshot`)).status).toBe(200);

    const slow = app.diagnostics.find((entry) => entry.message === "slow sidebar snapshot request");
    expect(slow?.context).toMatchObject({ sourceMs: null, bridgeMs: null, catalogueMs: null });
  });
});

describe("destroy and incognito endpoints", () => {
  test("the preflight never destroys, and destroy refuses a body without confirm", async () => {
    const destroyed: string[] = [];
    const previewed: string[] = [];
    const app = harness({
      destroyPreflight: async (sessionId: string) => {
        previewed.push(sessionId);
        return {
          status: "ok" as const,
          sessionCount: 2,
          pathCount: 7,
          liveCount: 1,
          survivingIdentities: ["c:r:w"],
        };
      },
      destroySession: async (sessionId: string) => {
        destroyed.push(sessionId);
        return { status: "destroyed" as const, sessionIds: [sessionId], filesRemoved: 7 };
      },
    });

    const preflight = await fetch(`${app.url}/api/session/destroy/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ sessionId: "target" }),
    });
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toMatchObject({ sessionCount: 2, pathCount: 7, liveCount: 1 });
    expect(previewed).toEqual(["target"]);
    // The assertion the split exists for: describing a destroy must never perform one.
    expect(destroyed).toEqual([]);

    // The preflight's own body, replayed against the destroy route, must not delete anything.
    const replay = await fetch(`${app.url}/api/session/destroy`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ sessionId: "target" }),
    });
    expect(replay.status).toBe(400);
    expect(destroyed).toEqual([]);

    const confirmedFalse = await fetch(`${app.url}/api/session/destroy`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ sessionId: "target", confirm: false }),
    });
    expect(confirmedFalse.status).toBe(400);
    expect(destroyed).toEqual([]);

    const confirmed = await fetch(`${app.url}/api/session/destroy`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ sessionId: "target", confirm: true }),
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ status: "destroyed", filesRemoved: 7 });
    expect(destroyed).toEqual(["target"]);
  });

  test("an aborted destroy is a 200 carrying the refusal, not an error the client must decode", async () => {
    const app = harness({
      destroySession: async () => ({
        status: "aborted" as const,
        reason: "could not close the live workspace for target.",
      }),
    });
    const response = await fetch(`${app.url}/api/session/destroy`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ sessionId: "target", confirm: true }),
    });
    // The request succeeded; the operation declined to act. Collapsing that into an HTTP error
    // would lose the reason, which is the only part the reader needs.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "aborted" });
  });

  test("incognito requires a boolean and rejects a cross-origin caller", async () => {
    const marks: Array<{ sessionId: string; incognito: boolean }> = [];
    const app = harness({
      setIncognito: async (sessionId: string, incognito: boolean) => {
        marks.push({ sessionId, incognito });
        return { status: "ok" as const, incognito };
      },
    });

    const bad = await fetch(`${app.url}/api/session/incognito`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ sessionId: "target", incognito: "yes" }),
    });
    expect(bad.status).toBe(400);

    const foreign = await fetch(`${app.url}/api/session/incognito`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://attacker.example" },
      body: JSON.stringify({ sessionId: "target", incognito: true }),
    });
    expect(foreign.status).toBe(403);
    expect(marks).toEqual([]);

    const ok = await fetch(`${app.url}/api/session/incognito`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: JSON.stringify({ sessionId: "target", incognito: true }),
    });
    expect(ok.status).toBe(200);
    expect(marks).toEqual([{ sessionId: "target", incognito: true }]);
  });
});

describe("sidebar change stream", () => {
  /** A source that lets a test move the revision by hand, standing in for cmux saying so. */
  function changeableSource(): {
    readonly source: SidebarSource;
    readonly bump: () => void;
    readonly replaceDurably: (snapshot: SidebarSnapshot) => void;
    readonly snapshots: () => number;
  } {
    const listeners = new Set<(revision: number) => void>();
    let revision = 0;
    let snapshots = 0;
    let currentSnapshot = EMPTY_SNAPSHOT;
    let durableChanged = false;
    const notify = (): void => {
      revision += 1;
      for (const listener of listeners) listener(revision);
    };
    const source: SidebarSource = {
      snapshot: async () => {
        snapshots += 1;
        return currentSnapshot;
      },
      declineSuggestion: async () => ({ status: "ok" as const }),
      setIncognito: async (_sessionId: string, incognito: boolean) =>
        ({ status: "ok" as const, incognito }),
      destroyPreflight: async () => ({ status: "not-found" as const }),
      destroySession: async () => ({ status: "not-found" as const }),
      closeWorkspace: async (): Promise<CloseWorkspaceOutcome> => ({ status: "not-live" }),
      focusWorkspace: async (): Promise<FocusWorkspaceOutcome> => ({ status: "not-live" }),
      closeLooseWorkspace: async (): Promise<CloseWorkspaceOutcome> => ({ status: "not-live" }),
      setPinned: async (): Promise<PinWorkspaceOutcome> => ({ status: "not-live" }),
      open: async (): Promise<OpenSessionOutcome> => ({ status: "focused", workspaceRef: "workspace:1" }),
      setLifecycle: async (): Promise<SessionLifecycleOutcome> =>
        ({ status: "ok", lifecycle: "completed" }),
      retire: async (): Promise<SessionLifecycleOutcome> => ({ status: "ok", lifecycle: "completed" }),
      faviconFor: () => null,
      reconcileDurableState: () => {
        if (!durableChanged) return;
        durableChanged = false;
        notify();
      },
      revision: () => revision,
      onRevision: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return {
      source,
      snapshots: () => snapshots,
      bump: notify,
      replaceDurably: (snapshot) => {
        currentSnapshot = snapshot;
        durableChanged = true;
      },
    };
  }

  /** Read whole SSE frames off the stream, so an assertion never sees half a message. */
  async function frames(
    response: Response,
    until: (seen: readonly string[]) => boolean,
  ): Promise<string[]> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("the change stream had no body");
    const decoder = new TextDecoder();
    const seen: string[] = [];
    let buffer = "";
    while (!until(seen)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        seen.push(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    await reader.cancel();
    return seen;
  }

  test("opens with the current revision, so a reconnecting client can tell it missed one", async () => {
    const { source, bump } = changeableSource();
    const server = createSidebarServer({ source, assets: ASSETS, port: 0, changeAnnounceDelayMs: 1 });
    running.push(server);
    bump();
    bump();

    const response = await fetch(`${server.url.origin}/api/events`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const seen = await frames(response, (f) => f.length >= 1);

    expect(seen[0]).toBe('data: {"revision":2}');
  });

  test("announces a change without being asked for a snapshot", async () => {
    const { source, bump } = changeableSource();
    const server = createSidebarServer({ source, assets: ASSETS, port: 0, changeAnnounceDelayMs: 1 });
    running.push(server);

    const response = await fetch(`${server.url.origin}/api/events`);
    const collected = frames(response, (f) => f.length >= 2);
    await Bun.sleep(5);
    bump();

    expect((await collected)[1]).toBe('data: {"revision":1}');
  });

  test("an already-connected client sees a durable change without reopening", async () => {
    const { source, replaceDurably } = changeableSource();
    let reconcile: (() => void) | undefined;
    const monitor = startSidebarChangeMonitor({
      source,
      subscribe: () => ({ stop: () => {} }),
      scheduleEvery: (callback) => {
        reconcile = callback;
        return { stop: () => {} };
      },
    });
    const server = createSidebarServer({
      source,
      assets: ASSETS,
      port: 0,
      changeAnnounceDelayMs: 1,
      snapshotRepresentationTtlMs: 60_000,
    });
    running.push(server);

    const first = await fetch(`${server.url.origin}/api/snapshot`);
    const etag = first.headers.get("etag") ?? "";
    await first.arrayBuffer();
    const changes = await fetch(`${server.url.origin}/api/events`);
    const announced = frames(changes, (seen) => seen.length >= 2);

    replaceDurably({
      ...EMPTY_SNAPSHOT,
      lifecycleCounts: { ...EMPTY_SNAPSHOT.lifecycleCounts, active: 1 },
    });
    reconcile?.();
    expect((await announced)[1]).toBe('data: {"revision":1}');

    const changed = await fetch(`${server.url.origin}/api/snapshot`, {
      headers: { "if-none-match": etag },
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      lifecycleCounts: { active: 1 },
      snapshotRevision: 1,
    });
    monitor.stop();
  });

  test("collapses a burst into one announcement", async () => {
    // A window closing emits a frame per workspace it held. Waking the client for each would have
    // it refetch the same snapshot several times over.
    const { source, bump } = changeableSource();
    const server = createSidebarServer({ source, assets: ASSETS, port: 0, changeAnnounceDelayMs: 20 });
    running.push(server);

    const response = await fetch(`${server.url.origin}/api/events`);
    const collected = frames(response, (f) => f.length >= 2);
    await Bun.sleep(5);
    bump();
    bump();
    bump();
    const seen = await collected;
    await Bun.sleep(40);

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe('data: {"revision":3}');
  });

  test("a change drops cached representations, so the refetch it prompts is not answered stale", async () => {
    // Without this the stream would be an instruction to ask again and get the same bytes back.
    const { source, bump, snapshots } = changeableSource();
    const server = createSidebarServer({
      source,
      assets: ASSETS,
      port: 0,
      changeAnnounceDelayMs: 1,
      snapshotRepresentationTtlMs: 60_000,
    });
    running.push(server);

    await fetch(`${server.url.origin}/api/snapshot`);
    await fetch(`${server.url.origin}/api/snapshot`);
    const beforeChange = snapshots();
    expect(beforeChange).toBe(1);

    bump();
    await fetch(`${server.url.origin}/api/snapshot`);

    expect(snapshots()).toBe(beforeChange + 1);
  });

  test("a disconnected client stops being written to", async () => {
    const { source, bump } = changeableSource();
    const server = createSidebarServer({ source, assets: ASSETS, port: 0, changeAnnounceDelayMs: 1 });
    running.push(server);

    const abort = new AbortController();
    const response = await fetch(`${server.url.origin}/api/events`, { signal: abort.signal });
    await frames(response, (f) => f.length >= 1);
    abort.abort();
    await Bun.sleep(5);

    // The listener is gone, so this must not throw inside the server's announce loop.
    expect(() => bump()).not.toThrow();
    await Bun.sleep(5);

    // A fresh client still works, which a leaked or broken listener set would prevent.
    const second = await fetch(`${server.url.origin}/api/events`);
    const seen = await frames(second, (f) => f.length >= 1);
    expect(seen[0]).toBe('data: {"revision":1}');
  });
});
