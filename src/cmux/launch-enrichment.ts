import { spawn as spawnChild } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimeRoot } from "../paths.ts";
import { err, ok, type Result } from "../result.ts";

const NOHUP_BINARY = "/usr/bin/nohup";

export interface DetachedEnrichmentProcess {
  unref(): void;
}

export interface DetachedEnrichmentSpawnOptions {
  readonly stdin: "ignore";
  readonly stdout: number;
  readonly stderr: number;
  readonly env: Record<string, string | undefined>;
  readonly detached: true;
}

export interface ImmediateEnrichmentDependencies {
  readonly ccsBinary: string;
  readonly nohupBinary: string;
  readonly environment: Record<string, string | undefined>;
  logPath(sessionId: string): string;
  openLog(path: string): number;
  closeLog(fd: number): void;
  spawn(
    command: readonly string[],
    options: DetachedEnrichmentSpawnOptions,
  ): DetachedEnrichmentProcess;
}

export interface ImmediateEnrichmentLaunch {
  readonly logPath: string;
}

/** One append-only runtime log per explicitly targeted session. */
export function immediateEnrichmentLogPath(sessionId: string): string {
  return join(runtimeRoot(), "enrich", `${sessionId}.log`);
}

function ccsBinary(): string {
  return process.env.CCS_BIN ?? join(import.meta.dir, "..", "..", "bin", "ccs");
}

function productionDependencies(): ImmediateEnrichmentDependencies {
  return {
    ccsBinary: ccsBinary(),
    nohupBinary: NOHUP_BINARY,
    environment: process.env,
    logPath: immediateEnrichmentLogPath,
    openLog(path): number {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      return openSync(path, "a", 0o600);
    },
    closeLog: closeSync,
    spawn(command, options): DetachedEnrichmentProcess {
      const [file, ...args] = command;
      if (!file) throw new Error("empty enrichment command");
      return spawnChild(file, args, {
        stdio: [options.stdin, options.stdout, options.stderr],
        env: options.env,
        detached: options.detached,
      });
    },
  };
}

/** Launch `ccs enrich <explicit-uuid>` in a new POSIX session that survives workspace teardown. */
export function launchImmediateEnrichment(
  sessionId: string,
  deps: ImmediateEnrichmentDependencies = productionDependencies(),
): Result<ImmediateEnrichmentLaunch> {
  const logPath = deps.logPath(sessionId);
  let logFd: number | null = null;
  try {
    logFd = deps.openLog(logPath);
    const child = deps.spawn(
      [deps.nohupBinary, deps.ccsBinary, "enrich", sessionId],
      {
        stdin: "ignore",
        stdout: logFd,
        stderr: logFd,
        env: deps.environment,
        detached: true,
      },
    );
    child.unref();
    return ok({ logPath });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`cannot launch immediate enrichment: ${detail} (log: ${logPath})`));
  } finally {
    if (logFd !== null) {
      try {
        deps.closeLog(logFd);
      } catch {
        // The child already inherited the descriptor; a parent-side close failure is non-fatal.
      }
    }
  }
}
