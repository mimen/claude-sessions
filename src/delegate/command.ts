import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import {
  addTag,
  ensureRow,
  getRow,
  openCatalogue,
  setMeta,
  setParent,
  setResumeId,
  setSessionClass,
} from "../catalogue/db.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir } from "../paths.ts";
import { providerFamily } from "../index/cost-rollup.ts";
import { err, ok, type Result } from "../result.ts";
import { parseDelegateArgs } from "./args.ts";
import { inferParentProvider, type ProviderFamily } from "./seat.ts";
import {
  executeDelegate,
  type DelegateDependencies,
  type DelegateLaunchResult,
  type DelegateReservation,
} from "./execute.ts";

function defaultSeatsRoot(environment: Readonly<Record<string, string | undefined>>): string {
  return environment.CCS_SEATS_ROOT
    ?? join(environment.HOME ?? homedir(), "Documents", "milad-vault", "ClaudeConfig", "seats");
}

function errorText(error: object): string {
  return error instanceof Error ? error.message : String(error);
}

function reserveDelegate(db: Database, input: DelegateReservation): Result<void> {
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      ensureRow(db, input.parentSessionId, now);
      ensureRow(db, input.sessionId, now);
      setResumeId(db, input.sessionId, input.sessionId, now);
      setParent(db, input.sessionId, input.parentSessionId, now);
      setSessionClass(db, input.sessionId, "auxiliary", now);
      for (const tag of ["auxiliary", "delegated", `seat:${input.seat}`, `provider:${input.provider}`]) {
        addTag(db, input.sessionId, tag);
      }
      setMeta(db, input.sessionId, "relation", "causal_child", now);
      setMeta(db, input.sessionId, "seat", input.seat, now);
      setMeta(db, input.sessionId, "provider", input.provider, now);
      setMeta(db, input.sessionId, "launcher", input.launcher, now);
      setMeta(db, input.sessionId, "requested_model", input.requestedModel, now);
      setMeta(db, input.sessionId, "compiled_model", input.compiledModel, now);
      setMeta(db, input.sessionId, "launch_cwd", input.cwd, now);
      setMeta(db, input.sessionId, "launch_status", "reserved", now);
    })();
    return ok(undefined);
  } catch (error) {
    return err(new Error(`Failed to reserve delegated session ${input.sessionId}: ${errorText(error as object)}`));
  }
}

function readIndexedParent<T>(
  sessionId: string,
  query: string,
): T | null {
  if (!existsSync(DB_PATH())) return null;
  let index: Database;
  try {
    // Parent inspection must never trigger the index's rebuild-on-schema-mismatch path. The
    // immutable URI also avoids trying to write a WAL sidecar while a concurrent reindex runs.
    index = new Database(`${pathToFileURL(DB_PATH()).href}?immutable=1`, { readonly: true });
  } catch {
    return null;
  }
  try {
    return index.query(query).get({ $id: sessionId }) as T | null;
  } catch {
    return null;
  } finally {
    index.close();
  }
}

function parentExists(catalogue: Database, sessionId: string): boolean {
  if (getRow(catalogue, sessionId)) return true;
  return readIndexedParent<{ found: number }>(
    sessionId,
    "SELECT 1 AS found FROM sessions WHERE session_id = $id OR resume_id = $id LIMIT 1",
  ) !== null;
}

function observedParentProvider(sessionId: string): ProviderFamily | null {
  const row = readIndexedParent<{ cost_by_model: string }>(
    sessionId,
    "SELECT cost_by_model FROM sessions WHERE session_id = $id OR resume_id = $id LIMIT 1",
  );
  if (!row) return null;
  let models: string[];
  try {
    models = Object.keys(JSON.parse(row.cost_by_model) as Record<string, number>);
  } catch {
    return null;
  }
  const providers = new Set(models.map(providerFamily).filter((provider) => provider !== "other"));
  return providers.size === 1 ? [...providers][0]! : null;
}

function resolveParentProvider(
  catalogue: Database,
  parentSessionId: string,
  parentIsCurrent: boolean,
  environment: Readonly<Record<string, string | undefined>>,
): ProviderFamily | null {
  if (parentIsCurrent) return inferParentProvider(environment);
  const observed = observedParentProvider(parentSessionId);
  if (observed) return observed;
  const metadata = getRow(catalogue, parentSessionId)?.meta.provider;
  return metadata === "claude" || metadata === "gpt" ? metadata : null;
}

function createDependencies(
  db: Database,
  environment: Readonly<Record<string, string | undefined>>,
): DelegateDependencies {
  return {
    environment,
    mintSessionId: randomUUID,
    cwdExists: (path) => {
      try {
        return existsSync(path) && statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    reserve: (input) => reserveDelegate(db, input),
    launch: (input): Result<DelegateLaunchResult> => {
      try {
        const process = Bun.spawnSync([...input.argv], {
          cwd: input.cwd,
          env: { ...input.environment },
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        return ok({ exitCode: process.exitCode });
      } catch (error) {
        return err(new Error(errorText(error as object)));
      }
    },
    recordExit: (sessionId, exitCode) => {
      const now = new Date().toISOString();
      setMeta(db, sessionId, "launch_status", "exited", now);
      setMeta(db, sessionId, "exit_code", exitCode, now);
    },
    recordLaunchFailure: (sessionId, message) => {
      const now = new Date().toISOString();
      setMeta(db, sessionId, "launch_status", "failed", now);
      setMeta(db, sessionId, "launch_error", message, now);
    },
  };
}

export function delegateCommand(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const parsed = parseDelegateArgs(args, environment);
  if (!parsed.ok) {
    console.error(`ccs delegate: ${parsed.error.message}`);
    return 2;
  }

  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    if (!parsed.value.parentIsCurrent && !parentExists(db, parsed.value.parentSessionId)) {
      console.error(`ccs delegate: parent session does not exist: ${parsed.value.parentSessionId}`);
      return 2;
    }
    const result = executeDelegate(
      {
        seat: parsed.value.seat,
        parentSessionId: parsed.value.parentSessionId,
        parentProvider: resolveParentProvider(
          db,
          parsed.value.parentSessionId,
          parsed.value.parentIsCurrent,
          environment,
        ),
        cwd: parsed.value.cwd,
        prompt: parsed.value.prompt,
        seatsRoot: parsed.value.seatsRoot ?? defaultSeatsRoot(environment),
      },
      createDependencies(db, environment),
    );
    if (!result.ok) {
      console.error(`ccs delegate: ${result.error.message}`);
      return 1;
    }
    return result.value.exitCode;
  } finally {
    db.close();
  }
}
