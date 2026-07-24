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
  setCreatorKind,
  setCreatorRef,
  setLaunchChannel,
  setLauncherIdentity,
  type CreatorKind,
} from "../catalogue/db.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir } from "../paths.ts";
import { err, ok, type Result } from "../result.ts";
import { parseDelegateArgs } from "./args.ts";
import { resolveDelegateCreator } from "../session-provenance.ts";
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

interface DelegateCreatorContext {
  readonly kind: CreatorKind;
  readonly ref: string | null;
  readonly launcherIdentity: string | null;
}

function reserveDelegate(
  db: Database,
  input: DelegateReservation,
  creator: DelegateCreatorContext,
): Result<void> {
  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      ensureRow(db, input.parentSessionId, now);
      ensureRow(db, input.sessionId, now);
      setResumeId(db, input.sessionId, input.sessionId, now);
      setParent(db, input.sessionId, input.parentSessionId, now);
      setSessionClass(db, input.sessionId, "auxiliary", now);
      setCreatorKind(db, input.sessionId, creator.kind, now);
      setCreatorRef(db, input.sessionId, creator.ref, now);
      setLaunchChannel(db, input.sessionId, "ccs_delegate", now);
      setLauncherIdentity(db, input.sessionId, creator.launcherIdentity, now);
      for (const tag of ["auxiliary", "delegated", `seat:${input.seat}`, `provider:${input.provider}`]) {
        addTag(db, input.sessionId, tag);
      }
      setMeta(db, input.sessionId, "relation", "causal_child", now);
      setMeta(db, input.sessionId, "seat", input.seat, now);
      setMeta(db, input.sessionId, "delegation_route", input.route, now);
      setMeta(db, input.sessionId, "provider", input.provider, now);
      setMeta(db, input.sessionId, "launcher", input.launcher, now);
      setMeta(db, input.sessionId, "effective_effort", input.effort, now);
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

function createDependencies(
  db: Database,
  environment: Readonly<Record<string, string | undefined>>,
  creator: DelegateCreatorContext,
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
    reserve: (input) => reserveDelegate(db, input, creator),
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
  const creatorResult = resolveDelegateCreator(environment, parsed.value.parentSessionId);
  if (!creatorResult.ok) {
    console.error(`ccs delegate: ${creatorResult.error.message}`);
    return 2;
  }
  const creator: DelegateCreatorContext = {
    kind: creatorResult.value.kind,
    ref: creatorResult.value.ref,
    launcherIdentity: environment.CLAUDE_IDENTITY ?? null,
  };

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
        route: parsed.value.useFallback ? "fallback" : "primary",
        cwd: parsed.value.cwd,
        prompt: parsed.value.prompt,
        seatsRoot: parsed.value.seatsRoot ?? defaultSeatsRoot(environment),
      },
      createDependencies(db, {
        ...environment,
        // These internal values survive only as far as the stable shim, which verifies the
        // pre-reserved birth and removes them before the final child harness starts.
        CCS_LAUNCH_CREATOR_KIND: creator.kind,
        CCS_LAUNCH_CREATOR_REF: creator.ref ?? undefined,
      }, creator),
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
