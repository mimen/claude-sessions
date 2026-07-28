import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSidebarServer, isLoopbackSidebarHost } from "./server.ts";
import type {
  OpenSessionOutcome,
  SessionLifecycleAction,
  SessionLifecycleOutcome,
  SidebarSource,
  CloseWorkspaceOutcome,
  FocusWorkspaceOutcome,
  PinWorkspaceOutcome,
} from "./snapshot.ts";
import type { SidebarSnapshot, SidebarView } from "./projection.ts";

const EMPTY_SNAPSHOT: SidebarSnapshot = {
  rows: [],
  livenessReadable: true,
  indexReadable: true,
  catalogueReadable: true,
  lifecycleCounts: { active: 0, completed: 0, archived: 0 },
  generatedAt: 1,
};

const ASSETS = new Map([
  ["/index.html", { body: "<html>sidebar</html>", type: "text/html; charset=utf-8" }],
  ["/main.js", { body: "console.log(1)", type: "text/javascript; charset=utf-8" }],
]);

interface Harness {
  readonly url: string;
  readonly opened: string[];
  readonly snapshotScopes: SidebarView[];
  readonly lifecycleChanges: Array<{
    readonly sessionId: string;
    readonly action: SessionLifecycleAction;
  }>;
  stop(): void;
}

const running: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

function harness(overrides: Partial<SidebarSource> = {}): Harness {
  // Built below from the base source, so a test overriding setLifecycle still drives retire.
  const opened: string[] = [];
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
      return { status: "ok", lifecycle: action === "archive" ? "archived" : "completed" };
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
  const server = createSidebarServer({ source: withRetire, assets: ASSETS, port: 0 });
  running.push(server);
  return {
    url: server.url.origin,
    opened,
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

function postLifecycle(
  app: Harness,
  origin: string | null,
  body: string = JSON.stringify({ sessionId: "abc", action: "archive" }),
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
    expect(await response.json()).toEqual(EMPTY_SNAPSHOT);
    expect(app.snapshotScopes).toEqual(["active"]);
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
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid snapshot view" });
    expect(app.snapshotScopes).toEqual(["completed", "triage"]);
  });

  test("reports a snapshot failure instead of serving a partial page", async () => {
    const app = harness({ snapshot: async () => { throw new Error("cmux is down"); } });
    const response = await fetch(`${app.url}/api/snapshot`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "snapshot failed" });
  });

  test("allows an open request from the bound same origin", async () => {
    const app = harness();
    const response = await postOpen(app, app.url);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "focused" });
    expect(app.opened).toEqual(["abc"]);
  });

  test("does not expose source error details from an open failure", async () => {
    const app = harness({
      open: async () => {
        throw new Error("failed at /private/catalogue.db");
      },
    });
    const response = await postOpen(app, app.url);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "open failed" });
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
    expect(await response.json()).toEqual({ status: "ok", lifecycle: "archived" });
    expect(app.lifecycleChanges).toEqual([{ sessionId: "abc", action: "archive" }]);
  });

  test("passes through not-found without mutating an unknown session", async () => {
    const app = harness({
      setLifecycle: async () => ({ status: "not-found" }),
    });
    const response = await postLifecycle(app, app.url);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "not-found" });
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

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden host" });
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

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden host" });
    expect(snapshotCalls).toBe(0);
  });

  test("accepts only literal loopback bind addresses", () => {
    const source: SidebarSource = {
      snapshot: async () => EMPTY_SNAPSHOT,
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
