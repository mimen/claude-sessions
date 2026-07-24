import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.ts";
import {
  CATALOGUE_PATH,
  CATALOGUE_SERVICE_LOCK_PATH,
  CATALOGUE_SERVICE_SOCKET_PATH,
  DB_PATH,
  ensureDataDir,
  ensureRunDir,
} from "../paths.ts";
import { CatalogueAuthority } from "./authority.ts";
import { createCatalogueHttpHandler } from "./http.ts";
import { CATALOGUE_PROTOCOL_VERSION, type CatalogueHealthResult } from "./protocol.ts";
import { requestUnixHttp } from "./transport.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_FRESH_MS = 5_000;
const LOCK_STARTUP_GRACE_MS = 5_000;
const LockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  instanceId: z.string().uuid(),
  startedAt: z.string().datetime(),
});
const HealthProbeSchema = z.object({
  protocolVersion: z.literal(CATALOGUE_PROTOCOL_VERSION),
  service: z.object({
    pid: z.number().int().positive(),
    instanceId: z.string().uuid(),
    startedAt: z.string().datetime(),
    idleTimeoutMs: z.number().int().positive(),
  }),
  sourceStatus: z.object({
    generation: z.number().int().nonnegative(),
    phase: z.enum(["idle", "refreshing", "error"]),
    freshness: z.enum(["uninitialized", "fresh", "stale"]),
    indexedAt: z.string().nullable(),
    refreshedAt: z.string().nullable(),
    ageMs: z.number().nonnegative().nullable(),
    staleAfterMs: z.number().int().positive(),
    rowCount: z.number().int().nonnegative(),
    lastError: z.object({ at: z.string(), message: z.string() }).nullable(),
    lastRefresh: z.object({
      scanned: z.number().int().nonnegative(),
      parsed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
    }),
  }),
});
type LockOwner = z.infer<typeof LockOwnerSchema>;

export type CatalogueDaemonResult =
  | { readonly status: "stopped" }
  | { readonly status: "already-running"; readonly pid: number | null }
  | { readonly status: "failed"; readonly message: string };

export interface CatalogueDaemonOptions {
  readonly idleTimeoutMs?: number;
  readonly freshMs?: number;
  readonly socketPath?: string;
  readonly lockPath?: string;
}

interface ClaimedInstance {
  readonly owner: LockOwner;
  readonly lockPath: string;
  readonly socketPath: string;
}

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function processOwnsCatalogueDaemon(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return false;
    const command = result.stdout.toString();
    return command.includes("catalogue-service") && command.includes("serve");
  } catch {
    // If process identity cannot be inspected, fail closed rather than risking two writers.
    return true;
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = LockOwnerSchema.safeParse(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function claimInstance(lockPath: string, socketPath: string):
  | { readonly status: "claimed"; readonly claim: ClaimedInstance }
  | { readonly status: "busy"; readonly pid: number | null }
  | { readonly status: "failed"; readonly message: string } {
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner: LockOwner = {
      pid: process.pid,
      instanceId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
    };
    let madeDirectory = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      madeDirectory = true;
      writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return { status: "claimed", claim: { owner, lockPath, socketPath } };
    } catch (cause) {
      if (madeDirectory) rmSync(lockPath, { recursive: true, force: true });
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || madeDirectory) {
        return { status: "failed", message: `Cannot claim catalogue service ownership: ${(cause as Error).message}` };
      }
      const existing = readOwner(lockPath);
      if (existing && processOwnsCatalogueDaemon(existing.pid)) {
        return { status: "busy", pid: existing.pid };
      }
      let oldEnough = existing !== null;
      if (!oldEnough) {
        try {
          oldEnough = Date.now() - statSync(lockPath).mtimeMs >= LOCK_STARTUP_GRACE_MS;
        } catch {
          oldEnough = false;
        }
      }
      if (!oldEnough) return { status: "busy", pid: existing?.pid ?? null };
      rmSync(lockPath, { recursive: true, force: true });
      rmSync(socketPath, { force: true });
    }
  }
  return { status: "busy", pid: readOwner(lockPath)?.pid ?? null };
}

function releaseInstance(claim: ClaimedInstance, removeSocket = true): void {
  const current = readOwner(claim.lockPath);
  if (current?.instanceId !== claim.owner.instanceId) return;
  if (removeSocket) rmSync(claim.socketPath, { force: true });
  rmSync(claim.lockPath, { recursive: true, force: true });
}

export async function probeCatalogueHealth(
  socketPath: string = CATALOGUE_SERVICE_SOCKET_PATH(),
  timeoutMs = 250,
): Promise<CatalogueHealthResult | null> {
  try {
    const response = await requestUnixHttp(socketPath, "/v1/health", { timeoutMs });
    if (response.status < 200 || response.status >= 300) return null;
    const parsed = HealthProbeSchema.safeParse(JSON.parse(response.body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Run the foreground daemon until explicit shutdown, signal, or idle timeout. */
export async function runCatalogueDaemon(
  options: CatalogueDaemonOptions = {},
): Promise<CatalogueDaemonResult> {
  ensureDataDir();
  ensureRunDir();
  const socketPath = options.socketPath ?? CATALOGUE_SERVICE_SOCKET_PATH();
  const lockPath = options.lockPath ?? CATALOGUE_SERVICE_LOCK_PATH();
  const idleTimeoutMs = options.idleTimeoutMs ?? positiveEnv("CCS_CATALOGUE_IDLE_MS", DEFAULT_IDLE_TIMEOUT_MS);
  const freshMs = options.freshMs ?? positiveEnv("CCS_CATALOGUE_FRESH_MS", DEFAULT_FRESH_MS);

  const active = await probeCatalogueHealth(socketPath);
  if (active) return { status: "already-running", pid: active.service.pid };

  const claimed = claimInstance(lockPath, socketPath);
  if (claimed.status === "busy") return { status: "already-running", pid: claimed.pid };
  if (claimed.status === "failed") return { status: "failed", message: claimed.message };
  const claim = claimed.claim;

  // A daemon whose lock was manually removed can still own the socket. Never unlink a verified
  // live endpoint after claiming a replacement lock.
  const activeAfterClaim = await probeCatalogueHealth(socketPath);
  if (activeAfterClaim) {
    releaseInstance(claim, false);
    return { status: "already-running", pid: activeAfterClaim.service.pid };
  }
  rmSync(socketPath, { force: true });

  const config = loadConfig();
  if (!config.ok) {
    releaseInstance(claim);
    return { status: "failed", message: config.error.message };
  }

  let authority: CatalogueAuthority;
  try {
    authority = new CatalogueAuthority({
      indexPath: DB_PATH(),
      cataloguePath: CATALOGUE_PATH(),
      config: config.value,
      freshMs,
    });
  } catch (cause) {
    releaseInstance(claim);
    return { status: "failed", message: `Cannot initialize catalogue authority: ${(cause as Error).message}` };
  }

  let activeRequests = 0;
  let lastActivityAt = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let stopResolved = false;
  let resolveStop: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  const requestStop = (): void => {
    if (stopResolved) return;
    stopResolved = true;
    resolveStop?.();
  };
  const scheduleIdleCheck = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    const elapsed = Date.now() - lastActivityAt;
    const remaining = Math.max(1, idleTimeoutMs - elapsed);
    idleTimer = setTimeout(() => {
      if (activeRequests > 0 || authority.isRefreshing) {
        lastActivityAt = Date.now();
        scheduleIdleCheck();
        return;
      }
      if (Date.now() - lastActivityAt >= idleTimeoutMs) {
        requestStop();
      } else {
        scheduleIdleCheck();
      }
    }, remaining);
  };

  const service = {
    pid: process.pid,
    instanceId: claim.owner.instanceId,
    startedAt: claim.owner.startedAt,
    idleTimeoutMs,
  } satisfies CatalogueHealthResult["service"];

  try {
    const handleRequest = createCatalogueHttpHandler({
      authority,
      service,
      onRequestStart: () => {
        activeRequests++;
        lastActivityAt = Date.now();
        scheduleIdleCheck();
      },
      onRequestEnd: () => {
        activeRequests = Math.max(0, activeRequests - 1);
        lastActivityAt = Date.now();
        scheduleIdleCheck();
      },
      onShutdown: requestStop,
    });
    server = Bun.serve({
      unix: socketPath,
      fetch: (request, bunServer) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/_control/refresh") {
          bunServer.timeout(request, 0);
        } else if (
          pathname === "/_control/title" ||
          pathname === "/_control/title-failure" ||
          pathname === "/v1/source-status" ||
          pathname === "/v1/root-sessions/query" ||
          pathname === "/v1/source/lookup"
        ) {
          bunServer.timeout(request, 255);
        }
        return handleRequest(request);
      },
    });
    chmodSync(socketPath, 0o600);
  } catch (cause) {
    await authority.close();
    releaseInstance(claim);
    return { status: "failed", message: `Cannot listen on catalogue socket: ${(cause as Error).message}` };
  }

  const onSignal = (): void => requestStop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  scheduleIdleCheck();

  try {
    await stopped;
    if (idleTimer) clearTimeout(idleTimer);
    await server.stop();
    await authority.close();
    return { status: "stopped" };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    releaseInstance(claim);
  }
}

export function catalogueServicePaths(): {
  readonly socketPath: string;
  readonly lockPath: string;
} {
  return {
    socketPath: CATALOGUE_SERVICE_SOCKET_PATH(),
    lockPath: CATALOGUE_SERVICE_LOCK_PATH(),
  };
}
