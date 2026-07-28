import { closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CATALOGUE_SERVICE_LOG_PATH,
  CATALOGUE_SERVICE_SOCKET_PATH,
  ensureRunDir,
} from "../paths.ts";
import { type Result, err, ok } from "../result.ts";
import type {
  CatalogueErrorCode,
  CatalogueHealthResult,
  CatalogueMutationResult,
  CatalogueProtocolError,
  CatalogueRefreshResult,
  CatalogueShutdownResult,
  RootSessionPage,
  RootSessionQuery,
  SourceLookup,
  SourceLookupResult,
  SourceStatusResult,
} from "./protocol.ts";
import { CATALOGUE_PROTOCOL_VERSION } from "./protocol.ts";
import { probeCatalogueHealth, terminateWedgedCatalogueService } from "./server.ts";
import {
  requestUnixHttp,
  UnixHttpTimeoutError,
  type UnixHttpResponse,
} from "./transport.ts";

const START_TIMEOUT_MS = 5_000;

function catalogueRefreshTimeoutMs(): number {
  const raw = process.env.CCS_CATALOGUE_REFRESH_TIMEOUT_MS;
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export interface CatalogueClientError {
  readonly code: CatalogueErrorCode | "unavailable" | "protocol_error";
  readonly message: string;
}

interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: object;
  readonly autoStart: boolean;
  /** Zero disables the transport timeout for explicit maintenance work such as title backfill. */
  readonly timeoutMs?: number;
  readonly retryOnTransportError?: boolean;
  readonly terminateServiceOnTimeout?: boolean;
}

function ccsBinary(): string {
  return process.env.CCS_BIN ?? join(import.meta.dir, "..", "..", "bin", "ccs");
}

function spawnCatalogueService(): Result<void, CatalogueClientError> {
  ensureRunDir();
  let logFd: number | null = null;
  try {
    logFd = openSync(CATALOGUE_SERVICE_LOG_PATH(), "a", 0o600);
    // Keep CCS_BIN's executable contract (absolute path or PATH lookup), including native test
    // doubles. Prefix the current Bun directory so bin/ccs's `env bun` shebang also works under
    // launchd's intentionally minimal environment.
    const path = [dirname(process.execPath), process.env.PATH]
      .filter((entry): entry is string => Boolean(entry))
      .join(":");
    const child = Bun.spawn([ccsBinary(), "catalogue-service", "serve"], {
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      env: { ...process.env, PATH: path },
    });
    child.unref();
    return ok(undefined);
  } catch (cause) {
    return err({
      code: "unavailable",
      message: `Cannot start catalogue service: ${(cause as Error).message}`,
    });
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
}

async function ensureCatalogueService(socketPath: string): Promise<Result<void, CatalogueClientError>> {
  if (await probeCatalogueHealth(socketPath)) return ok(undefined);
  const spawned = spawnCatalogueService();
  if (!spawned.ok) return spawned;

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeCatalogueHealth(socketPath)) return ok(undefined);
    await Bun.sleep(25);
  }
  return err({
    code: "unavailable",
    message: `Catalogue service did not become ready; see ${CATALOGUE_SERVICE_LOG_PATH()}.`,
  });
}

function protocolError(message: string): Result<never, CatalogueClientError> {
  return err({ code: "protocol_error", message });
}

async function requestJson<T>(
  path: string,
  options: RequestOptions,
): Promise<Result<T, CatalogueClientError>> {
  const socketPath = CATALOGUE_SERVICE_SOCKET_PATH();
  if (options.autoStart) {
    const ready = await ensureCatalogueService(socketPath);
    if (!ready.ok) return ready;
  }

  const serializedBody = options.body ? JSON.stringify(options.body) : undefined;
  const execute = async (): Promise<UnixHttpResponse> => requestUnixHttp(socketPath, path, {
    method: options.method ?? "GET",
    body: serializedBody,
    timeoutMs: options.timeoutMs,
    headers: serializedBody
      ? {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(serializedBody)),
        }
      : undefined,
  });

  let response: UnixHttpResponse;
  try {
    response = await execute();
  } catch (cause) {
    if (cause instanceof UnixHttpTimeoutError && options.terminateServiceOnTimeout) {
      const terminated = terminateWedgedCatalogueService();
      return err({
        code: "unavailable",
        message: terminated
          ? "Catalogue refresh timed out; stopped the wedged service."
          : "Catalogue refresh timed out; the service could not be safely identified for termination.",
      });
    }
    if (!options.autoStart) {
      return err({ code: "unavailable", message: "Catalogue service is not running." });
    }
    if (options.retryOnTransportError === false) {
      return err({ code: "unavailable", message: "Catalogue service is unavailable." });
    }
    // The daemon can idle out between readiness and the actual request. Restart/retry once.
    const ready = await ensureCatalogueService(socketPath);
    if (!ready.ok) return ready;
    try {
      response = await execute();
    } catch (retryCause) {
      if (retryCause instanceof UnixHttpTimeoutError && options.terminateServiceOnTimeout) {
        terminateWedgedCatalogueService();
      }
      return err({ code: "unavailable", message: "Catalogue service is unavailable." });
    }
  }

  let body: object;
  try {
    body = JSON.parse(response.body) as object;
  } catch {
    return protocolError("Catalogue service returned invalid JSON.");
  }
  const version = "protocolVersion" in body ? body.protocolVersion : null;
  if (version !== CATALOGUE_PROTOCOL_VERSION) {
    return protocolError(`Unsupported catalogue protocol version: ${String(version)}.`);
  }
  if (response.status < 200 || response.status >= 300) {
    const protocol = body as CatalogueProtocolError;
    if (!protocol.error?.code || !protocol.error.message) {
      return protocolError("Catalogue service returned an invalid error response.");
    }
    return err(protocol.error);
  }
  return ok(body as T);
}

export function queryCatalogueRoots(
  query: Partial<RootSessionQuery> = {},
): Promise<Result<RootSessionPage, CatalogueClientError>> {
  return requestJson<RootSessionPage>("/v1/root-sessions/query", {
    method: "POST",
    body: query,
    autoStart: true,
    timeoutMs: 120_000,
  });
}

export function lookupCatalogueSource(
  input: SourceLookup,
): Promise<Result<SourceLookupResult, CatalogueClientError>> {
  return requestJson<SourceLookupResult>("/v1/source/lookup", {
    method: "POST",
    body: input,
    autoStart: true,
    timeoutMs: 120_000,
  });
}

export function getCatalogueSourceStatus(): Promise<Result<SourceStatusResult, CatalogueClientError>> {
  return requestJson<SourceStatusResult>("/v1/source-status", {
    autoStart: true,
    timeoutMs: 120_000,
  });
}

export function getCatalogueHealth(
  autoStart = false,
): Promise<Result<CatalogueHealthResult, CatalogueClientError>> {
  return requestJson<CatalogueHealthResult>("/v1/health", { autoStart });
}

export function refreshCatalogueAuthority(options: {
  readonly force: boolean;
  readonly titles: boolean;
}): Promise<Result<CatalogueRefreshResult, CatalogueClientError>> {
  const timeoutMs = options.titles ? 0 : catalogueRefreshTimeoutMs();
  const bounded = timeoutMs > 0;
  return requestJson<CatalogueRefreshResult>("/_control/refresh", {
    method: "POST",
    body: options,
    autoStart: true,
    // Manual maintenance stays unbounded by default. The launchd job opts into a
    // generous watchdog; on timeout the client hard-stops only a positively identified
    // daemon so a later interval can start a clean authority.
    timeoutMs,
    retryOnTransportError: !bounded,
    terminateServiceOnTimeout: bounded,
  });
}

export function saveCatalogueTitle(
  sessionId: string,
  title: string,
): Promise<Result<CatalogueMutationResult, CatalogueClientError>> {
  return requestJson<CatalogueMutationResult>("/_control/title", {
    method: "POST",
    body: { sessionId, title },
    autoStart: true,
    timeoutMs: 120_000,
  });
}

export function recordCatalogueTitleFailure(
  sessionId: string,
): Promise<Result<CatalogueMutationResult, CatalogueClientError>> {
  return requestJson<CatalogueMutationResult>("/_control/title-failure", {
    method: "POST",
    body: { sessionId },
    autoStart: true,
    timeoutMs: 120_000,
  });
}

export function shutdownCatalogueService(): Promise<Result<CatalogueShutdownResult, CatalogueClientError>> {
  return requestJson<CatalogueShutdownResult>("/_control/shutdown", {
    method: "POST",
    autoStart: false,
  });
}
