/**
 * The sidebar's local web host.
 *
 * It serves one page and four endpoints on loopback, and nothing that would let a browser reach
 * past the projection: no database handles, no transcripts, no session file paths, and no
 * arbitrary command execution. Every request is answered by the injected `SidebarSource`, so
 * the server itself holds no knowledge of cmux, git, or SQLite.
 */
import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { log } from "../logger.ts";
import { err, ok, type Result } from "../result.ts";
import { loadFavicon } from "./favicon.ts";
import { RECOMMENDATIONS } from "../catalogue/enrichment-schema.ts";
import { SIDEBAR_VIEWS, type SidebarLifecycle, type SidebarView } from "./projection.ts";
import type {
  SessionLifecycleAction,
  SidebarSnapshotMeasurement,
  SidebarSource,
} from "./snapshot.ts";
import { startEventLoopLagSampler, type EventLoopLagSampler } from "./event-loop-lag.ts";
import { sidebarHttpError, type SidebarHttpErrorCode } from "./http-error.ts";

/**
 * Row-count bounds for `?limit`. Below the minimum the list cannot fill a screen; above it a
 * single response would carry more sessions than anyone scrolls in one sitting.
 */
const MIN_ROW_LIMIT = 20;
const MAX_ROW_LIMIT = 2_000;
/** Match the source's live-tree freshness so polls never wait on repeated full projections. */
const SNAPSHOT_REPRESENTATION_TTL_MS = 2_500;
/** The browser uses only a handful of query shapes; keep hand-written requests from growing forever. */
const MAX_SNAPSHOT_REPRESENTATIONS = 16;
/** Bound retained serialized bodies even when several queries project the maximum row count. */
const MAX_SNAPSHOT_REPRESENTATION_BYTES = 4 * 1024 * 1024;

/** cmux's Dock needs a stable origin, so the port is fixed unless deliberately overridden. */
export const DEFAULT_SIDEBAR_PORT = 8787;
export const DEFAULT_SIDEBAR_HOST = "127.0.0.1";

export interface SidebarServerLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface SidebarServerOptions {
  readonly source: SidebarSource;
  /** The built browser bundle: the page, plus the assets it references. */
  readonly assets: ReadonlyMap<string, { readonly body: string; readonly type: string }>;
  readonly port?: number;
  readonly hostname?: string;
  /** Injectable so action diagnostics can be asserted without scraping source or stderr. */
  readonly logger?: SidebarServerLogger;
  /** Test seam; production uses the source-aligned 2.5-second representation freshness. */
  readonly snapshotRepresentationTtlMs?: number;
  /** Test seam; production retains at most four MiB of serialized snapshot bodies. */
  readonly snapshotRepresentationMaxBytes?: number;
  /** Test seam so a slow-request assertion does not depend on the real scheduler. */
  readonly lagSampler?: EventLoopLagSampler;
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

/** Triage and incognito are views, not lifecycles; the snapshot maps each back to a list plus a filter. */
function isSidebarView(value: string): value is SidebarView {
  // Derived from SIDEBAR_VIEWS rather than repeated here. The hand-written list this replaces had
  // already fallen behind the type: a view could be added, typecheck clean, and still be rejected
  // at the door with a bad_request the client could not explain.
  return (SIDEBAR_VIEWS as readonly string[]).includes(value);
}

function isLifecycleAction(value: JsonValue | undefined): value is SessionLifecycleAction {
  return value === "complete"
    || value === "save"
    || value === "uncomplete"
    || value === "unsave";
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

/** Marking a session incognito. A boolean, so the caller always states which way it is going. */
function parseIncognitoRequest(
  value: JsonValue,
): Result<{ sessionId: string; incognito: boolean }, string> {
  if (!isJsonObject(value)) return err("request body must be an object");
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !Object.prototype.hasOwnProperty.call(value, "sessionId")
    || !Object.prototype.hasOwnProperty.call(value, "incognito")
  ) {
    return err("request body must contain only sessionId and incognito");
  }
  const sessionId = value.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return err("sessionId is required");
  }
  const incognito = value.incognito;
  if (typeof incognito !== "boolean") return err("incognito must be a boolean");
  return ok({ sessionId, incognito });
}

/**
 * Destroy requires an explicit `confirm: true` alongside the id.
 *
 * Not a security control -- anything that can reach this loopback port can also set a boolean. It
 * is a shape control: the preflight body is `{ sessionId }`, so no client can destroy by replaying
 * the request it just used to ask what destroying would do.
 */
function parseDestroyRequest(value: JsonValue): Result<{ sessionId: string }, string> {
  if (!isJsonObject(value)) return err("request body must be an object");
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !Object.prototype.hasOwnProperty.call(value, "sessionId")
    || !Object.prototype.hasOwnProperty.call(value, "confirm")
  ) {
    return err("request body must contain only sessionId and confirm");
  }
  const sessionId = value.sessionId;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return err("sessionId is required");
  }
  if (value.confirm !== true) return err("confirm must be true");
  return ok({ sessionId });
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

function jsonText(
  body: string,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function snapshotEtag(body: string): string {
  // A strong ETag describes the bytes on the wire. Source revision counters also advance for
  // equal database commits and background refreshes, which turned byte-identical snapshots into
  // full 200 responses. The serialized projection already includes every browser-visible fact.
  const digest = createHash("sha256").update(body).digest("base64url");
  return `"${digest}"`;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value === etag;
  });
}

interface SnapshotQuery {
  readonly scope: SidebarView;
  readonly limit: number | undefined;
  readonly include: readonly SidebarLifecycle[];
}

interface SnapshotRepresentation {
  readonly body: string;
  readonly byteLength: number;
  readonly etag: string;
  readonly completedAt: number;
}

interface SnapshotRepresentationEntry {
  representation?: SnapshotRepresentation;
  rebuild?: Promise<SnapshotRepresentation>;
}

function snapshotQueryKey(query: SnapshotQuery): string {
  return JSON.stringify([query.scope, query.limit ?? null, query.include]);
}

function snapshotResponse(request: Request, representation: SnapshotRepresentation): Response {
  if (etagMatches(request.headers.get("if-none-match"), representation.etag)) {
    return new Response(null, {
      status: 304,
      headers: { etag: representation.etag, "cache-control": "no-cache" },
    });
  }
  return jsonText(representation.body, 200, {
    etag: representation.etag,
    "cache-control": "no-cache",
  });
}

function json(body: object, status = 200): Response {
  return jsonText(JSON.stringify(body), status);
}

function errorJson(
  code: SidebarHttpErrorCode,
  legacyStatus?: "not-found" | "failed",
  /**
   * Which refusal this was, from the closed vocabulary of them.
   *
   * A code rather than the outcome's `reason`: reasons are free text and can carry absolute paths
   * and database errors, which must not reach a client. A refusal code cannot, being one of a
   * fixed set, and it is enough for a client to say "this workspace is shared" instead of "CCS
   * could not complete that action".
   */
  refusal?: string,
): Response {
  const { status: httpStatus, ...envelope } = sidebarHttpError(code);
  const body = {
    ...envelope,
    ...(legacyStatus === undefined ? {} : { status: legacyStatus }),
    ...(refusal === undefined ? {} : { refusal }),
  };
  return json(body, httpStatus);
}

function logUnexpected(
  logger: SidebarServerLogger,
  label: string,
  error: unknown,
  details: JsonObject = {},
): void {
  logger.warn(label, {
    ...details,
    error: error instanceof Error ? error.message : String(error),
  });
}

function actionFailureCode(status: string | undefined): SidebarHttpErrorCode | null {
  switch (status) {
    case "not-found":
    case "not-live":
      return "not_found";
    case "liveness-unreadable":
      return "liveness_unreadable";
    case "catalogue-unreadable":
      return "catalogue_unreadable";
    case "index-unreadable":
      return "index_unreadable";
    case "timeout":
      return "timeout";
    case "failed":
      return "action_failed";
    default:
      return null;
  }
}

function actionJson(
  logger: SidebarServerLogger,
  operation: string,
  outcome: object & {
    readonly status?: string;
    readonly reason?: string;
    readonly refusal?: string;
  },
  details: JsonObject,
  invalidateSnapshots: () => void,
): Response {
  const code = actionFailureCode(outcome.status);
  if (code === null) {
    invalidateSnapshots();
    return json(outcome);
  }

  logger.warn("sidebar action failed", {
    operation,
    ...details,
    status: outcome.status,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
  const legacyStatus = outcome.status === "not-found" || outcome.status === "not-live"
    ? "not-found"
    : "failed";
  return errorJson(code, legacyStatus, outcome.refusal);
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
  return errorJson("denied");
}

export function createSidebarServer(options: SidebarServerOptions): Bun.Server<undefined> {
  const port = options.port ?? DEFAULT_SIDEBAR_PORT;
  const hostname = options.hostname ?? DEFAULT_SIDEBAR_HOST;
  const { source, assets } = options;
  const logger = options.logger ?? log;
  // Sampled continuously rather than around each request: the starvation worth catching
  // happens between requests as readily as during one.
  const lagSampler = options.lagSampler ?? startEventLoopLagSampler();
  const snapshotRepresentationTtlMs = options.snapshotRepresentationTtlMs
    ?? SNAPSHOT_REPRESENTATION_TTL_MS;
  const snapshotRepresentationMaxBytes = Math.max(
    0,
    options.snapshotRepresentationMaxBytes ?? MAX_SNAPSHOT_REPRESENTATION_BYTES,
  );
  const snapshotRepresentations = new Map<string, SnapshotRepresentationEntry>();
  let snapshotRepresentationBytes = 0;

  function removeCachedEntry(key: string): void {
    const entry = snapshotRepresentations.get(key);
    if (entry === undefined) return;
    snapshotRepresentationBytes -= entry.representation?.byteLength ?? 0;
    snapshotRepresentations.delete(key);
  }

  function invalidateSnapshots(): void {
    snapshotRepresentations.clear();
    snapshotRepresentationBytes = 0;
  }

  function cachedEntry(key: string): SnapshotRepresentationEntry | undefined {
    const entry = snapshotRepresentations.get(key);
    if (entry === undefined) return undefined;
    // Map insertion order doubles as a tiny LRU, including cold entries currently rebuilding.
    snapshotRepresentations.delete(key);
    snapshotRepresentations.set(key, entry);
    return entry;
  }

  function createCachedEntry(key: string): SnapshotRepresentationEntry {
    while (snapshotRepresentations.size >= MAX_SNAPSHOT_REPRESENTATIONS) {
      const oldest = snapshotRepresentations.keys().next().value;
      if (oldest === undefined) break;
      removeCachedEntry(oldest);
    }
    const entry: SnapshotRepresentationEntry = {};
    snapshotRepresentations.set(key, entry);
    return entry;
  }

  function publishRepresentation(
    key: string,
    entry: SnapshotRepresentationEntry,
    representation: SnapshotRepresentation,
  ): void {
    if (snapshotRepresentations.get(key) !== entry) return;

    snapshotRepresentationBytes -= entry.representation?.byteLength ?? 0;
    delete entry.representation;
    if (representation.byteLength > snapshotRepresentationMaxBytes) {
      removeCachedEntry(key);
      return;
    }

    while (snapshotRepresentationBytes + representation.byteLength > snapshotRepresentationMaxBytes) {
      const oldest = [...snapshotRepresentations.keys()].find((candidate) => candidate !== key);
      if (oldest === undefined) break;
      removeCachedEntry(oldest);
    }
    if (snapshotRepresentations.get(key) !== entry) return;
    entry.representation = representation;
    snapshotRepresentationBytes += representation.byteLength;
  }

  function rebuildSnapshot(
    key: string,
    entry: SnapshotRepresentationEntry,
    query: SnapshotQuery,
  ): Promise<SnapshotRepresentation> {
    if (entry.rebuild !== undefined) return entry.rebuild;

    const rebuild = (async (): Promise<SnapshotRepresentation> => {
      const startedAt = performance.now();
      // A holder rather than a bare `let`: control-flow analysis cannot see the callback run,
      // so a plain variable narrows to `never` at the read and would need a cast to recover.
      const measured: { value: SidebarSnapshotMeasurement | null } = { value: null };
      const snapshot = await source.snapshot(query.scope, query.limit, query.include, (seen) => {
        measured.value = seen;
      });
      const serializationStartedAt = performance.now();
      const body = JSON.stringify(snapshot);
      const serializationMs = performance.now() - serializationStartedAt;
      const byteLength = Buffer.byteLength(body);
      const representation = {
        body,
        byteLength,
        etag: snapshotEtag(body),
        completedAt: performance.now(),
      };
      const totalMs = representation.completedAt - startedAt;
      if (totalMs >= 100) {
        // Phases and loop lag together are what make this line actionable. Phases alone cannot
        // distinguish a source that blocked from a process that was descheduled, because a phase
        // spanning a starved period reports the starvation as its own work.
        const phases = measured.value?.phases;
        logger.warn("slow sidebar snapshot request", {
          view: query.scope,
          rowCount: snapshot.rows.length,
          payloadBytes: byteLength,
          totalMs,
          serializationMs,
          sourceMs: measured.value?.totalMs ?? null,
          bridgeMs: phases?.bridgeMs ?? null,
          catalogueMs: phases?.catalogueMs ?? null,
          indexMs: phases?.indexMs ?? null,
          statusMs: phases?.statusMs ?? null,
          workspaceStateMs: phases?.workspaceStateMs ?? null,
          messageCountMs: phases?.messageCountMs ?? null,
          directoryFactsMs: phases?.directoryFactsMs ?? null,
          notificationsMs: phases?.notificationsMs ?? null,
          projectionMs: phases?.projectionMs ?? null,
          eventLoopLagMs: lagSampler.takePeak(),
          livenessReadable: snapshot.livenessReadable,
          catalogueReadable: snapshot.catalogueReadable,
          indexReadable: snapshot.indexReadable,
        });
      }
      // An action or byte/count eviction may have removed this entry while its read was in flight.
      publishRepresentation(key, entry, representation);
      return representation;
    })();
    entry.rebuild = rebuild;
    void rebuild.finally(() => {
      if (entry.rebuild === rebuild) delete entry.rebuild;
    }).catch(() => {});
    return rebuild;
  }

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
          return errorJson("bad_request");
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
            value === "completed" || value === "saved");
        const query: SnapshotQuery = { scope, limit, include };
        const key = snapshotQueryKey(query);
        try {
          if (request.headers.get("x-ccs-refresh-liveness") === "1") {
            // A native bridge focus changed state outside HTTP. Drop only this query so load(true)
            // waits for a completed projection instead of accepting its previous representation.
            removeCachedEntry(key);
            source.refreshSnapshotLiveness?.();
          }
          const entry = cachedEntry(key) ?? createCachedEntry(key);
          const cached = entry.representation;
          if (cached === undefined) {
            return snapshotResponse(request, await rebuildSnapshot(key, entry, query));
          }

          if (performance.now() - cached.completedAt >= snapshotRepresentationTtlMs) {
            const refresh = rebuildSnapshot(key, entry, query);
            void refresh.catch((error: unknown) => {
              logger.warn("sidebar snapshot background refresh failed", {
                view: scope,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
          return snapshotResponse(request, cached);
        } catch (error) {
          logger.warn("sidebar snapshot request failed", {
            view: scope,
            error: error instanceof Error ? error.message : String(error),
          });
          return errorJson("internal_failure");
        }
      }

      if (url.pathname === "/api/open" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return errorJson("denied");
        }
        let sessionId: JsonValue | undefined;
        try {
          sessionId = ((await request.json()) as JsonObject).sessionId;
        } catch {
          return errorJson("bad_request");
        }
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          return errorJson("bad_request");
        }
        try {
          return actionJson(logger, "open", await source.open(sessionId), { sessionId }, invalidateSnapshots);
        } catch (error) {
          logUnexpected(logger, "sidebar open request failed", error, { sessionId });
          return errorJson("internal_failure");
        }
      }

      if (url.pathname === "/api/session/lifecycle" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return errorJson("denied");
        }

        let parsedBody: Result<LifecycleRequestBody, string>;
        try {
          parsedBody = parseLifecycleRequest((await request.json()) as JsonValue);
        } catch {
          return errorJson("bad_request");
        }
        if (!parsedBody.ok) return errorJson("bad_request");

        try {
          return actionJson(logger, "lifecycle", await source.retire(
            parsedBody.value.sessionId,
            parsedBody.value.action,
          ), {
            action: parsedBody.value.action,
            sessionId: parsedBody.value.sessionId,
          }, invalidateSnapshots);
        } catch (error) {
          logUnexpected(logger, "sidebar lifecycle request failed", error, {
            action: parsedBody.value.action,
            sessionId: parsedBody.value.sessionId,
          });
          return errorJson("internal_failure");
        }
      }

      // Declining a verdict. Not a lifecycle change -- nothing about the session moves -- so it is
      // its own endpoint rather than another action on the lifecycle one.
      if (url.pathname === "/api/session/decline" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return errorJson("denied");
        }
        let parsed: Result<{ sessionId: string; verb: string }, string>;
        try {
          parsed = parseDeclineRequest((await request.json()) as JsonValue);
        } catch {
          return errorJson("bad_request");
        }
        if (!parsed.ok) return errorJson("bad_request");
        try {
          return actionJson(
            logger,
            "decline",
            await source.declineSuggestion(parsed.value.sessionId, parsed.value.verb),
            { sessionId: parsed.value.sessionId, verb: parsed.value.verb },
            invalidateSnapshots,
          );
        } catch (error) {
          logUnexpected(logger, "sidebar decline request failed", error, {
            sessionId: parsed.value.sessionId,
            verb: parsed.value.verb,
          });
          return errorJson("internal_failure");
        }
      }

      // Marking a session incognito. Its own endpoint rather than a lifecycle action because a
      // marked session keeps whatever lifecycle it had -- nothing about where it sits moves.
      if (url.pathname === "/api/session/incognito" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return errorJson("denied");
        }
        let parsed: Result<{ sessionId: string; incognito: boolean }, string>;
        try {
          parsed = parseIncognitoRequest((await request.json()) as JsonValue);
        } catch {
          return errorJson("bad_request");
        }
        if (!parsed.ok) return errorJson("bad_request");
        try {
          return actionJson(
            logger,
            "incognito",
            await source.setIncognito(parsed.value.sessionId, parsed.value.incognito),
            { sessionId: parsed.value.sessionId, incognito: parsed.value.incognito },
            invalidateSnapshots,
          );
        } catch (error) {
          logUnexpected(logger, "sidebar incognito request failed", error, {
            sessionId: parsed.value.sessionId,
          });
          return errorJson("internal_failure");
        }
      }

      // What a destroy would remove. Deliberately separate from the destroy itself, and read-only:
      // the confirmation dialog needs these figures before the reader decides, and an endpoint
      // that sometimes deletes is one client typo away from deleting when asked to describe.
      if (url.pathname === "/api/session/destroy/preflight" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return errorJson("denied");
        }
        let sessionId: JsonValue | undefined;
        try {
          sessionId = ((await request.json()) as JsonObject).sessionId;
        } catch {
          return errorJson("bad_request");
        }
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          return errorJson("bad_request");
        }
        try {
          return actionJson(
            logger,
            "destroy-preflight",
            await source.destroyPreflight(sessionId),
            { sessionId },
            // A read changes nothing, so the cached snapshots stay valid.
            () => {},
          );
        } catch (error) {
          logUnexpected(logger, "sidebar destroy preflight failed", error, { sessionId });
          return errorJson("internal_failure");
        }
      }

      // The irreversible one. `confirm: true` has to be in the body: it is not a security control
      // -- anything that can reach this port can send it -- but it does mean no client reaches
      // this path by replaying the preflight body it already had in hand.
      if (url.pathname === "/api/session/destroy" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return errorJson("denied");
        }
        let parsed: Result<{ sessionId: string }, string>;
        try {
          parsed = parseDestroyRequest((await request.json()) as JsonValue);
        } catch {
          return errorJson("bad_request");
        }
        if (!parsed.ok) return errorJson("bad_request");
        try {
          return actionJson(
            logger,
            "destroy",
            await source.destroySession(parsed.value.sessionId),
            { sessionId: parsed.value.sessionId },
            invalidateSnapshots,
          );
        } catch (error) {
          logUnexpected(logger, "sidebar destroy request failed", error, {
            sessionId: parsed.value.sessionId,
          });
          return errorJson("internal_failure");
        }
      }

      // Focusing a sessionless workspace: a browser split or plain shell has no session id to
      // address, so the workspace UUID is the address. Purely a view change in cmux.
      if (url.pathname === "/api/workspace/focus" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return errorJson("denied");
        }
        let workspaceId: unknown;
        try {
          workspaceId = ((await request.json()) as { workspaceId?: unknown }).workspaceId;
        } catch {
          return errorJson("bad_request");
        }
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
          return errorJson("bad_request");
        }
        try {
          return actionJson(logger, "workspace-focus", await source.focusWorkspace(workspaceId), {
            workspaceId,
          }, invalidateSnapshots);
        } catch (error) {
          logUnexpected(logger, "sidebar workspace focus request failed", error, { workspaceId });
          return errorJson("internal_failure");
        }
      }

      if (url.pathname === "/api/workspace/pin" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return errorJson("denied");
        }
        let body: { workspaceId?: unknown; pinned?: unknown };
        try {
          body = (await request.json()) as { workspaceId?: unknown; pinned?: unknown };
        } catch {
          return errorJson("bad_request");
        }
        if (typeof body.workspaceId !== "string" || body.workspaceId.length === 0) {
          return errorJson("bad_request");
        }
        if (typeof body.pinned !== "boolean") {
          return errorJson("bad_request");
        }
        try {
          return actionJson(logger, "workspace-pin", await source.setPinned(
            body.workspaceId,
            body.pinned,
          ), { workspaceId: body.workspaceId, pinned: body.pinned }, invalidateSnapshots);
        } catch (error) {
          logUnexpected(logger, "sidebar workspace pin request failed", error, {
            workspaceId: body.workspaceId,
            pinned: body.pinned,
          });
          return errorJson("internal_failure");
        }
      }

      // Closing a sessionless tab. The source refuses any workspace that holds a session, so
      // this can never become a back door around the session close proofs.
      if (url.pathname === "/api/workspace/close" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return errorJson("denied");
        }
        let workspaceId: unknown;
        try {
          workspaceId = ((await request.json()) as { workspaceId?: unknown }).workspaceId;
        } catch {
          return errorJson("bad_request");
        }
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
          return errorJson("bad_request");
        }
        try {
          return actionJson(logger, "workspace-close", await source.closeLooseWorkspace(workspaceId), {
            workspaceId,
          }, invalidateSnapshots);
        } catch (error) {
          logUnexpected(logger, "sidebar loose workspace close request failed", error, { workspaceId });
          return errorJson("internal_failure");
        }
      }

      if (url.pathname === "/api/session/close" && request.method === "POST") {
        if (!originIsBound(request, boundHostname, boundPort)) {
          return errorJson("denied");
        }
        let sessionId: unknown;
        try {
          sessionId = ((await request.json()) as { sessionId?: unknown }).sessionId;
        } catch {
          return errorJson("bad_request");
        }
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          return errorJson("bad_request");
        }
        try {
          return actionJson(
            logger,
            "session-close",
            await source.closeWorkspace(sessionId),
            { sessionId },
            invalidateSnapshots,
          );
        } catch (error) {
          logUnexpected(logger, "sidebar session close request failed", error, { sessionId });
          return errorJson("internal_failure");
        }
      }

      if (url.pathname === "/api/favicon" && request.method === "GET") {
        const directory = url.searchParams.get("dir");
        // The browser names a directory, never a file. The source decides whether that directory
        // is one it published; the selected path is then securely re-opened and re-validated.
        const file = directory ? source.faviconFor(directory) : null;
        const favicon = file && directory ? await loadFavicon(directory, file) : null;
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
