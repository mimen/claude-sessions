/**
 * The sidebar's local web host.
 *
 * It serves one page and four endpoints on loopback, and nothing that would let a browser reach
 * past the projection: no database handles, no transcripts, no session file paths, and no
 * arbitrary command execution. Every request is answered by the injected `SidebarSource`, so
 * the server itself holds no knowledge of cmux, git, or SQLite.
 */
import { isIPv4 } from "node:net";
import { err, ok, type Result } from "../result.ts";
import { loadFavicon } from "./favicon.ts";
import { RECOMMENDATIONS } from "../catalogue/enrichment-schema.ts";
import type { SidebarLifecycle, SidebarView } from "./projection.ts";
import type { SessionLifecycleAction, SidebarSource } from "./snapshot.ts";

/**
 * Row-count bounds for `?limit`. Below the minimum the list cannot fill a screen; above it a
 * single response would carry more sessions than anyone scrolls in one sitting.
 */
const MIN_ROW_LIMIT = 20;
const MAX_ROW_LIMIT = 2_000;

/** cmux's Dock needs a stable origin, so the port is fixed unless deliberately overridden. */
export const DEFAULT_SIDEBAR_PORT = 8787;
export const DEFAULT_SIDEBAR_HOST = "127.0.0.1";

export interface SidebarServerOptions {
  readonly source: SidebarSource;
  /** The built browser bundle: the page, plus the assets it references. */
  readonly assets: ReadonlyMap<string, { readonly body: string; readonly type: string }>;
  readonly port?: number;
  readonly hostname?: string;
}

type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

interface LifecycleRequestBody {
  readonly sessionId: string;
  readonly action: SessionLifecycleAction;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Triage is a view, not a lifecycle; the snapshot maps it back to the active list plus a filter. */
function isSidebarView(value: string): value is SidebarView {
  return value === "active" || value === "completed" || value === "archived" || value === "triage";
}

function isLifecycleAction(value: JsonValue | undefined): value is SessionLifecycleAction {
  return value === "complete"
    || value === "archive"
    || value === "uncomplete"
    || value === "unarchive";
}

function parseLifecycleRequest(value: JsonValue): Result<LifecycleRequestBody, string> {
  if (!isJsonObject(value)) return err("request body must be an object");
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !Object.prototype.hasOwnProperty.call(value, "sessionId")
    || !Object.prototype.hasOwnProperty.call(value, "action")
  ) {
    return err("request body must contain only sessionId and action");
  }
  const sessionId = value.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return err("sessionId is required");
  }
  if (!isLifecycleAction(value.action)) return err("action is invalid");
  return ok({ sessionId, action: value.action });
}

/**
 * Declining a verdict. Same shape as the lifecycle request, but the verb is the recommendation
 * being refused rather than a lifecycle action, so it gets its own parser rather than a widened
 * one -- the two vocabularies overlap ("archive") and conflating them would let a lifecycle action
 * arrive where a verdict belongs.
 */
function parseDeclineRequest(value: JsonValue): Result<{ sessionId: string; verb: string }, string> {
  if (!isJsonObject(value)) return err("request body must be an object");
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !Object.prototype.hasOwnProperty.call(value, "sessionId")
    || !Object.prototype.hasOwnProperty.call(value, "verb")
  ) {
    return err("request body must contain only sessionId and verb");
  }
  const sessionId = value.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return err("sessionId is required");
  }
  const verb = value.verb;
  if (typeof verb !== "string" || !RECOMMENDATIONS.includes(verb as never)) {
    return err("verb is invalid");
  }
  return ok({ sessionId, verb });
}

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Only literal loopback addresses are valid sidebar bind targets. */
export function isLoopbackSidebarHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "::1") return true;
  return isIPv4(normalized) && normalized.split(".")[0] === "127";
}

function formattedHostname(hostname: string): string {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function boundAuthority(hostname: string, port: number): string {
  const host = formattedHostname(hostname.toLowerCase());
  return port === 80 ? host : `${host}:${port}`;
}

function hostIsBound(request: Request, hostname: string, port: number): boolean {
  const host = request.headers.get("host")?.toLowerCase();
  if (!host) return false;
  if (host === boundAuthority(hostname, port)) return true;
  return port === 80 && host === `${formattedHostname(hostname.toLowerCase())}:80`;
}

/** Mutating requests must carry the exact origin of the address the server actually bound. */
function originIsBound(request: Request, hostname: string, port: number): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === `http://${boundAuthority(hostname, port)}`;
  } catch {
    return false;
  }
}

function forbiddenHost(): Response {
  return json({ error: "forbidden host" }, 403);
}

export function createSidebarServer(options: SidebarServerOptions): Bun.Server<undefined> {
  const port = options.port ?? DEFAULT_SIDEBAR_PORT;
  const hostname = options.hostname ?? DEFAULT_SIDEBAR_HOST;
  const { source, assets } = options;

  if (!isLoopbackSidebarHost(hostname)) {
    const renderedHostname = JSON.stringify(hostname);
    throw new Error(
      `sidebar host must be a literal loopback address (127.0.0.0/8 or ::1); received ${renderedHostname}`,
    );
  }

  return Bun.serve({
    port,
    hostname,
    async fetch(request: Request, server: Bun.Server<undefined>): Promise<Response> {
      const boundPort = server.port;
      const boundHostname = server.hostname;
      if (boundPort === undefined || boundHostname === undefined) return forbiddenHost();
      if (!hostIsBound(request, boundHostname, boundPort)) return forbiddenHost();

      const url = new URL(request.url);

      if (url.pathname === "/api/snapshot" && request.method === "GET") {
        const scopeValues = url.searchParams.getAll("scope");
        const scope = scopeValues.length === 0 ? "active" : scopeValues[0];
        if (scopeValues.length > 1 || scope === undefined || !isSidebarView(scope)) {
          return json({ error: "invalid snapshot view" }, 400);
        }
        // How many rows the client currently has room for. It grows as you scroll, which is what
        // makes the list unbounded; clamped so a hand-typed URL cannot ask for the whole store.
        const limitRaw = Number(url.searchParams.get("limit") ?? "");
        const limit = Number.isFinite(limitRaw)
          ? Math.min(Math.max(Math.trunc(limitRaw), MIN_ROW_LIMIT), MAX_ROW_LIMIT)
          : undefined;
        // Which finished sections the client currently has expanded. Anything not named is not
        // projected, so a shelved section costs nothing.
        const include = (url.searchParams.get("include") ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter((value): value is SidebarLifecycle =>
            value === "completed" || value === "archived");
        try {
          return json(await source.snapshot(scope, limit, include));
        } catch {
          return json({ error: "snapshot failed" }, 500);
        }
      }

      if (url.pathname === "/api/open" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return json({ error: "forbidden origin" }, 403);
        }
        let sessionId: JsonValue | undefined;
        try {
          sessionId = ((await request.json()) as JsonObject).sessionId;
        } catch {
          return json({ error: "invalid request body" }, 400);
        }
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          return json({ error: "sessionId is required" }, 400);
        }
        try {
          return json(await source.open(sessionId));
        } catch {
          return json({ error: "open failed" }, 500);
        }
      }

      if (url.pathname === "/api/session/lifecycle" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return json({ error: "forbidden origin" }, 403);
        }

        let parsedBody: Result<LifecycleRequestBody, string>;
        try {
          parsedBody = parseLifecycleRequest((await request.json()) as JsonValue);
        } catch {
          return json({ error: "invalid request body" }, 400);
        }
        if (!parsedBody.ok) return json({ error: parsedBody.error }, 400);

        try {
          return json(await source.retire(
            parsedBody.value.sessionId,
            parsedBody.value.action,
          ));
        } catch {
          // Source implementations should return a typed failure; this is the last boundary if one
          // violates that contract, and it still must not disclose catalogue paths or handles.
          return json({ status: "failed", reason: "session lifecycle update failed" });
        }
      }

      // Declining a verdict. Not a lifecycle change -- nothing about the session moves -- so it is
      // its own endpoint rather than another action on the lifecycle one.
      if (url.pathname === "/api/session/decline" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return json({ error: "forbidden origin" }, 403);
        }
        let parsed: Result<{ sessionId: string; verb: string }, string>;
        try {
          parsed = parseDeclineRequest((await request.json()) as JsonValue);
        } catch {
          return json({ error: "invalid request body" }, 400);
        }
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        try {
          return json(await source.declineSuggestion(parsed.value.sessionId, parsed.value.verb));
        } catch {
          return json({ status: "failed", reason: "could not record the decision" });
        }
      }

      // Focusing a sessionless workspace: a browser split or plain shell has no session id to
      // address, so the workspace UUID is the address. Purely a view change in cmux.
      if (url.pathname === "/api/workspace/focus" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return json({ error: "forbidden origin" }, 403);
        }
        let workspaceId: unknown;
        try {
          workspaceId = ((await request.json()) as { workspaceId?: unknown }).workspaceId;
        } catch {
          return json({ error: "invalid request body" }, 400);
        }
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
          return json({ error: "workspaceId is required" }, 400);
        }
        try {
          return json(await source.focusWorkspace(workspaceId));
        } catch {
          return json({ status: "failed", reason: "focusing the workspace failed" });
        }
      }

      if (url.pathname === "/api/workspace/pin" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return json({ error: "forbidden origin" }, 403);
        }
        let body: { workspaceId?: unknown; pinned?: unknown };
        try {
          body = (await request.json()) as { workspaceId?: unknown; pinned?: unknown };
        } catch {
          return json({ error: "invalid request body" }, 400);
        }
        if (typeof body.workspaceId !== "string" || body.workspaceId.length === 0) {
          return json({ error: "workspaceId is required" }, 400);
        }
        if (typeof body.pinned !== "boolean") {
          return json({ error: "pinned must be a boolean" }, 400);
        }
        try {
          return json(await source.setPinned(body.workspaceId, body.pinned));
        } catch {
          return json({ status: "failed", reason: "pinning the workspace failed" });
        }
      }

      // Closing a sessionless tab. The source refuses any workspace that holds a session, so
      // this can never become a back door around the session close proofs.
      if (url.pathname === "/api/workspace/close" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return json({ error: "forbidden origin" }, 403);
        }
        let workspaceId: unknown;
        try {
          workspaceId = ((await request.json()) as { workspaceId?: unknown }).workspaceId;
        } catch {
          return json({ error: "invalid request body" }, 400);
        }
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
          return json({ error: "workspaceId is required" }, 400);
        }
        try {
          return json(await source.closeLooseWorkspace(workspaceId));
        } catch {
          return json({ status: "failed", reason: "closing the workspace failed" });
        }
      }

      if (url.pathname === "/api/session/close" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return json({ error: "forbidden origin" }, 403);
        }
        let sessionId: unknown;
        try {
          sessionId = ((await request.json()) as { sessionId?: unknown }).sessionId;
        } catch {
          return json({ error: "invalid request body" }, 400);
        }
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          return json({ error: "sessionId is required" }, 400);
        }
        try {
          return json(await source.closeWorkspace(sessionId));
        } catch {
          // As with lifecycle: never surface a catalogue path or handle to the browser.
          return json({ status: "failed", reason: "closing the workspace failed" });
        }
      }

      if (url.pathname === "/api/favicon" && request.method === "GET") {
        const directory = url.searchParams.get("dir");
        // The browser names a directory, never a file. The source decides whether that directory
        // is one it published; the selected path is then securely re-opened and re-validated.
        const file = directory ? source.faviconFor(directory) : null;
        const favicon = file && directory ? loadFavicon(directory, file) : null;
        if (!favicon) return new Response("Not found", { status: 404 });
        return new Response(favicon.body, {
          headers: {
            "content-type": favicon.type,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        });
      }

      // Everything else is the single-page app. Only assets built into this server are served;
      // there is no filesystem path to traverse.
      const assetKey = url.pathname === "/" ? "/index.html" : url.pathname;
      const asset = assets.get(assetKey)
        ?? (url.pathname.includes(".") ? undefined : assets.get("/index.html"));
      if (!asset) return new Response("Not found", { status: 404 });

      return new Response(asset.body, {
        headers: { "content-type": asset.type, "cache-control": "no-store" },
      });
    },
  });
}
