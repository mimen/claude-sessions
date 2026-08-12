import { setExistingSessionLifecycle } from "../catalogue/commands.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import { err, ok, type Result } from "../result.ts";
import {
  closeSessionWorkspace,
  type CloseSessionWorkspaceOutcome,
} from "./close-current.ts";
import { launchImmediateEnrichment } from "./launch-enrichment.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FinishLifecycle = "complete" | "save";

export interface FinishCurrentEnvironment {
  readonly CLAUDE_CODE_SESSION_ID?: string;
}

export interface FinishSessionDependencies {
  recordLifecycle(sessionId: string, lifecycle: FinishLifecycle): Result<void>;
  launchEnrichment(sessionId: string): Result<{ readonly logPath: string }>;
  closeSessionWorkspace(
    sessionId: string,
    mutate: boolean,
  ): Promise<CloseSessionWorkspaceOutcome>;
}

interface FinishOutputDependencies {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface FinishCurrentDependencies
  extends FinishSessionDependencies, FinishOutputDependencies {
  readonly environment: FinishCurrentEnvironment;
}

export interface FinishCommandDependencies
  extends FinishSessionDependencies, FinishOutputDependencies {}

export type FinishSessionOutcome =
  | { readonly status: "invalid-session"; readonly error: Error }
  | { readonly status: "lifecycle-failed"; readonly error: Error }
  | {
    readonly status: "close-result";
    readonly sessionId: string;
    readonly lifecycle: FinishLifecycle;
    readonly lifecycleRecorded: boolean;
    readonly enrichmentWarning: string | null;
    readonly close: CloseSessionWorkspaceOutcome;
  };

interface ParsedCurrentArgs {
  readonly lifecycle: FinishLifecycle;
  readonly mutate: boolean;
}

interface ParsedFinishArgs extends ParsedCurrentArgs {
  readonly sessionId: string;
}

function finishLifecycle(value: string | undefined): FinishLifecycle | null {
  if (value === "complete") return "complete";
  if (value === "save") return "save";
  // Preserve the old terminal meaning for stale installed slash commands.
  if (value === "archive") return "complete";
  return null;
}

function parseCurrentArgs(args: readonly string[]): ParsedCurrentArgs | null {
  const lifecycle = finishLifecycle(args[0]);
  if (lifecycle === null) return null;
  if (args.length === 1) return { lifecycle, mutate: false };
  if (args.length === 2 && args[1] === "--do") return { lifecycle, mutate: true };
  return null;
}

function parseFinishArgs(args: readonly string[]): ParsedFinishArgs | null {
  const sessionId = args[0];
  const lifecycle = finishLifecycle(args[1]);
  if (!sessionId || lifecycle === null) return null;
  if (args.length === 2) return { sessionId, lifecycle, mutate: false };
  if (args.length === 3 && args[2] === "--do") {
    return { sessionId, lifecycle, mutate: true };
  }
  return null;
}

/** Resolve only an explicit Claude session UUID; aliases such as `.` are not accepted. */
export function explicitSessionId(sessionId: string | undefined): Result<string> {
  if (!sessionId) return err(new Error("session id is missing"));
  if (!UUID_PATTERN.test(sessionId)) return err(new Error(`session id is not a UUID: ${sessionId}`));
  return ok(sessionId);
}

/** Resolve only the explicit current Claude session UUID; aliases such as `.` are not accepted. */
export function explicitCurrentSessionId(environment: FinishCurrentEnvironment): Result<string> {
  const sessionId = environment.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return err(new Error("CLAUDE_CODE_SESSION_ID is unset"));
  if (!UUID_PATTERN.test(sessionId)) {
    return err(new Error(`CLAUDE_CODE_SESSION_ID is not a UUID: ${sessionId}`));
  }
  return ok(sessionId);
}

function recordSessionLifecycle(sessionId: string, lifecycle: FinishLifecycle): Result<void> {
  try {
    const outcome = setExistingSessionLifecycle(sessionId, lifecycle);
    if (outcome.status !== "ok") {
      return err(new Error(`per-session lifecycle command returned ${outcome.status}`));
    }
    return ok(undefined);
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

function productionSessionDependencies(): FinishSessionDependencies {
  return {
    recordLifecycle: recordSessionLifecycle,
    launchEnrichment: launchImmediateEnrichment,
    closeSessionWorkspace: (sessionId, mutate) => closeSessionWorkspace(sessionId, mutate),
  };
}

function productionCommandDependencies(): FinishCommandDependencies {
  return {
    ...productionSessionDependencies(),
    stdout: console.log,
    stderr: console.error,
  };
}

function productionCurrentDependencies(): FinishCurrentDependencies {
  return {
    ...productionCommandDependencies(),
    environment: { CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID },
  };
}

/** Ordered lifecycle primitive: validate, ensure row, record, launch detached enrichment, safe close. */
export async function finishSession(
  sessionId: string,
  lifecycle: FinishLifecycle,
  mutate: boolean,
  deps: FinishSessionDependencies = productionSessionDependencies(),
): Promise<FinishSessionOutcome> {
  const explicit = explicitSessionId(sessionId);
  if (!explicit.ok) return { status: "invalid-session", error: explicit.error };

  if (!mutate) {
    return {
      status: "close-result",
      sessionId: explicit.value,
      lifecycle,
      lifecycleRecorded: false,
      enrichmentWarning: null,
      close: await deps.closeSessionWorkspace(explicit.value, false),
    };
  }

  const recorded = deps.recordLifecycle(explicit.value, lifecycle);
  if (!recorded.ok) return { status: "lifecycle-failed", error: recorded.error };

  const launched = deps.launchEnrichment(explicit.value);
  const enrichmentWarning = launched.ok
    ? null
    : `${launched.error.message}; continuing close because ccs enrich --sweep can retry`;

  return {
    status: "close-result",
    sessionId: explicit.value,
    lifecycle,
    lifecycleRecorded: true,
    enrichmentWarning,
    close: await deps.closeSessionWorkspace(explicit.value, true),
  };
}

function renderOutcome(
  command: "finish" | "finish-current",
  outcome: FinishSessionOutcome,
  output: FinishOutputDependencies,
): number {
  switch (outcome.status) {
    case "invalid-session":
      output.stderr(`ccs ${command}: session failed: ${outcome.error.message}`);
      return 2;
    case "lifecycle-failed":
      output.stderr(`ccs ${command}: lifecycle failed: ${outcome.error.message}`);
      return 1;
    case "close-result": {
      if (outcome.enrichmentWarning) {
        output.stderr(`ccs ${command}: warning: ${outcome.enrichmentWarning}`);
      }
      switch (outcome.close.status) {
        case "authorized":
          output.stdout(JSON.stringify({
            status: "authorized",
            dryRun: true,
            ...outcome.close.identity,
          }));
          return 0;
        case "refused":
          output.stderr(JSON.stringify(outcome.close));
          return 2;
        case "close-failed":
          output.stderr(JSON.stringify({ status: "close-failed", ...outcome.close.identity }));
          return 1;
        case "closed":
          output.stdout(JSON.stringify({ status: "closed", ...outcome.close.identity }));
          return 0;
      }
    }
  }
}

/** `ccs finish <sessionId> <complete|save> [--do]`. */
export async function finishSessionCommand(
  args: string[],
  deps: FinishCommandDependencies = productionCommandDependencies(),
): Promise<number> {
  const parsed = parseFinishArgs(args);
  if (!parsed) {
    deps.stderr("usage: ccs finish <sessionId> <complete|save> [--do]");
    return 2;
  }
  return renderOutcome(
    "finish",
    await finishSession(parsed.sessionId, parsed.lifecycle, parsed.mutate, deps),
    deps,
  );
}

/** Current-session wrapper used by lifecycle slash commands. */
export async function finishCurrentCommand(
  args: string[],
  deps: FinishCurrentDependencies = productionCurrentDependencies(),
): Promise<number> {
  const parsed = parseCurrentArgs(args);
  if (!parsed) {
    deps.stderr("usage: ccs finish-current <complete|save> [--do]");
    return 2;
  }

  const current = explicitCurrentSessionId(deps.environment);
  if (!current.ok) {
    deps.stderr(`ccs finish-current: session failed: ${current.error.message}`);
    return 2;
  }
  return renderOutcome(
    "finish-current",
    await finishSession(current.value, parsed.lifecycle, parsed.mutate, deps),
    deps,
  );
}
