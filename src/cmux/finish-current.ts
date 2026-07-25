import { ensureSessionRow, mark } from "../catalogue/commands.ts";
import { launchImmediateEnrichment } from "./launch-enrichment.ts";
import { err, ok, type Result } from "../result.ts";
import { closeCurrentWorkspaceCommand } from "./close-current.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FinishLifecycle = "complete" | "archive";

export interface FinishCurrentEnvironment {
  readonly CLAUDE_CODE_SESSION_ID?: string;
}

export interface FinishCurrentDependencies {
  readonly environment: FinishCurrentEnvironment;
  ensureCatalogueRow(sessionId: string): Result<void>;
  recordLifecycle(sessionId: string, lifecycle: FinishLifecycle): Result<void>;
  launchEnrichment(sessionId: string): Result<{ readonly logPath: string }>;
  closeCurrentWorkspace(args: string[]): number;
  stderr(line: string): void;
}

interface ParsedFinishArgs {
  readonly lifecycle: FinishLifecycle;
  readonly mutate: boolean;
}

function parseArgs(args: readonly string[]): ParsedFinishArgs | null {
  const lifecycle = args[0];
  if (lifecycle !== "complete" && lifecycle !== "archive") return null;
  if (args.length === 1) return { lifecycle, mutate: false };
  if (args.length === 2 && args[1] === "--do") return { lifecycle, mutate: true };
  return null;
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
    const exitCode = mark(
      sessionId,
      lifecycle === "complete" ? ["--completed"] : ["--archived"],
    );
    if (exitCode !== 0) {
      return err(new Error(`per-session lifecycle command exited ${exitCode}`));
    }
    return ok(undefined);
  } catch (cause) {
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

function productionDependencies(): FinishCurrentDependencies {
  return {
    environment: { CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID },
    ensureCatalogueRow: ensureSessionRow,
    recordLifecycle: recordSessionLifecycle,
    launchEnrichment: launchImmediateEnrichment,
    closeCurrentWorkspace: closeCurrentWorkspaceCommand,
    stderr: console.error,
  };
}

function writeFailure(
  deps: FinishCurrentDependencies,
  stage: "session" | "catalogue" | "lifecycle",
  error: Error,
): void {
  deps.stderr(`ccs finish-current: ${stage} failed: ${error.message}`);
}

/** `ccs finish-current <complete|archive> [--do]`: ordered lifecycle, enrichment, then close. */
export function finishCurrentCommand(
  args: string[],
  deps: FinishCurrentDependencies = productionDependencies(),
): number {
  const parsed = parseArgs(args);
  if (!parsed) {
    deps.stderr("usage: ccs finish-current <complete|archive> [--do]");
    return 2;
  }

  if (!parsed.mutate) {
    return deps.closeCurrentWorkspace([]);
  }

  const current = explicitCurrentSessionId(deps.environment);
  if (!current.ok) {
    writeFailure(deps, "session", current.error);
    return 2;
  }
  const sessionId = current.value;

  const ensured = deps.ensureCatalogueRow(sessionId);
  if (!ensured.ok) {
    writeFailure(deps, "catalogue", ensured.error);
    return 1;
  }

  const recorded = deps.recordLifecycle(sessionId, parsed.lifecycle);
  if (!recorded.ok) {
    writeFailure(deps, "lifecycle", recorded.error);
    return 1;
  }

  const launched = deps.launchEnrichment(sessionId);
  if (!launched.ok) {
    deps.stderr(
      `ccs finish-current: warning: ${launched.error.message}; continuing close because ccs enrich --sweep can retry`,
    );
  }

  return deps.closeCurrentWorkspace(["--do"]);
}
