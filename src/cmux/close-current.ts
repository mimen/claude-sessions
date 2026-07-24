import { execFileSync } from "node:child_process";
import type { Bridge } from "./bridge.ts";
import { liveBridge } from "./live.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSE_TIMEOUT_MS = 5_000;

export interface CurrentWorkspaceEnvironment {
  CLAUDE_CODE_SESSION_ID?: string;
  CMUX_SURFACE_ID?: string;
  CMUX_WORKSPACE_ID?: string;
}

export interface CurrentWorkspaceIdentity {
  sessionId: string;
  surfaceId: string;
  workspaceId: string;
}

export type CloseRefusalReason =
  | "missing-session-id"
  | "invalid-session-id"
  | "missing-surface-id"
  | "invalid-surface-id"
  | "missing-workspace-id"
  | "invalid-workspace-id"
  | "bridge-unreadable"
  | "surface-not-live"
  | "tree-workspace-mismatch"
  | "surface-not-bound"
  | "surface-session-mismatch"
  | "hook-workspace-missing"
  | "hook-workspace-mismatch"
  | "session-not-live"
  | "session-surface-mismatch"
  | "session-workspace-mismatch"
  | "not-primary-surface"
  | "shared-workspace";

export type ClosePlan =
  | { status: "authorized"; identity: CurrentWorkspaceIdentity }
  | { status: "refused"; reason: CloseRefusalReason };

export interface CloseAttempt {
  ok: boolean;
}

export interface CloseProcessRunner {
  run(file: string, args: readonly string[], timeoutMs: number): CloseAttempt;
}

export interface CloseCurrentWorkspaceDependencies {
  environment: CurrentWorkspaceEnvironment;
  bridge: () => Bridge;
  close: (workspaceId: string) => CloseAttempt;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function requiredUuid(
  value: string | undefined,
  missing: CloseRefusalReason,
  invalid: CloseRefusalReason,
): { ok: true; value: string } | { ok: false; reason: CloseRefusalReason } {
  if (!value) return { ok: false, reason: missing };
  if (!UUID_PATTERN.test(value)) return { ok: false, reason: invalid };
  return { ok: true, value };
}

export function currentWorkspaceIdentity(environment: CurrentWorkspaceEnvironment): ClosePlan {
  const session = requiredUuid(
    environment.CLAUDE_CODE_SESSION_ID,
    "missing-session-id",
    "invalid-session-id",
  );
  if (!session.ok) return { status: "refused", reason: session.reason };

  const surface = requiredUuid(
    environment.CMUX_SURFACE_ID,
    "missing-surface-id",
    "invalid-surface-id",
  );
  if (!surface.ok) return { status: "refused", reason: surface.reason };

  const workspace = requiredUuid(
    environment.CMUX_WORKSPACE_ID,
    "missing-workspace-id",
    "invalid-workspace-id",
  );
  if (!workspace.ok) return { status: "refused", reason: workspace.reason };

  return {
    status: "authorized",
    identity: {
      sessionId: session.value,
      surfaceId: surface.value,
      workspaceId: workspace.value,
    },
  };
}

/**
 * Authorize closing only the exact cmux workspace occupied and owned by the current Claude session.
 * Every identity join is stable-UUID based. Missing, stale, shared, or contradictory state refuses.
 */
export function planCloseCurrentWorkspace(
  bridge: Bridge,
  environment: CurrentWorkspaceEnvironment,
): ClosePlan {
  const parsed = currentWorkspaceIdentity(environment);
  if (parsed.status === "refused") return parsed;
  const { identity } = parsed;

  if (!bridge.readable) return { status: "refused", reason: "bridge-unreadable" };

  const currentSurface = bridge.surfaceToWorkspace.get(identity.surfaceId);
  if (!currentSurface) return { status: "refused", reason: "surface-not-live" };
  if (currentSurface.workspaceId !== identity.workspaceId) {
    return { status: "refused", reason: "tree-workspace-mismatch" };
  }

  const binding = bridge.surfaceInfo(identity.surfaceId);
  if (!binding) return { status: "refused", reason: "surface-not-bound" };
  if (binding.sessionId !== identity.sessionId) {
    return { status: "refused", reason: "surface-session-mismatch" };
  }
  if (!binding.workspaceId) return { status: "refused", reason: "hook-workspace-missing" };
  if (binding.workspaceId !== identity.workspaceId) {
    return { status: "refused", reason: "hook-workspace-mismatch" };
  }

  const sessionLocation = bridge.locateSession(identity.sessionId);
  if (!sessionLocation) return { status: "refused", reason: "session-not-live" };
  if (sessionLocation.surfaceId !== identity.surfaceId) {
    return { status: "refused", reason: "session-surface-mismatch" };
  }
  if (sessionLocation.workspaceId !== identity.workspaceId) {
    return { status: "refused", reason: "session-workspace-mismatch" };
  }

  const primary = bridge.primarySurface(identity.workspaceId);
  if (primary?.surfaceId !== identity.surfaceId) {
    return { status: "refused", reason: "not-primary-surface" };
  }

  const workspaceSurfaces = bridge.surfacesInWorkspace(identity.workspaceId);
  if (workspaceSurfaces.length !== 1 || workspaceSurfaces[0]?.surfaceId !== identity.surfaceId) {
    return { status: "refused", reason: "shared-workspace" };
  }

  return { status: "authorized", identity };
}

export function closeWorkspaceByStableId(
  runner: CloseProcessRunner,
  cmuxBin: string,
  workspaceId: string,
): CloseAttempt {
  return runner.run(
    cmuxBin,
    ["close-workspace", "--workspace", workspaceId],
    CLOSE_TIMEOUT_MS,
  );
}

const productionRunner: CloseProcessRunner = {
  run(file: string, args: readonly string[], timeoutMs: number): CloseAttempt {
    try {
      execFileSync(file, [...args], { timeout: timeoutMs, stdio: "ignore" });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
};

function productionDependencies(): CloseCurrentWorkspaceDependencies {
  const cmuxBin = process.env.CMUX_BIN ?? "cmux";
  return {
    environment: {
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
      CMUX_SURFACE_ID: process.env.CMUX_SURFACE_ID,
      CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
    },
    bridge: () => liveBridge(cmuxBin),
    close: (workspaceId) => closeWorkspaceByStableId(productionRunner, cmuxBin, workspaceId),
    stdout: console.log,
    stderr: console.error,
  };
}

function writeRefusal(
  deps: CloseCurrentWorkspaceDependencies,
  phase: "preflight" | "revalidation",
  plan: Extract<ClosePlan, { status: "refused" }>,
): void {
  deps.stderr(JSON.stringify({ status: "refused", phase, reason: plan.reason }));
}

/** `ccs close-current-workspace [--do]`: dry-run by default; mutation requires two proofs. */
export function closeCurrentWorkspaceCommand(
  args: string[],
  deps: CloseCurrentWorkspaceDependencies = productionDependencies(),
): number {
  if (args.some((arg) => arg !== "--do")) {
    deps.stderr("usage: ccs close-current-workspace [--do]");
    return 2;
  }

  const mutate = args.includes("--do");
  const parsed = currentWorkspaceIdentity(deps.environment);
  if (parsed.status === "refused") {
    writeRefusal(deps, "preflight", parsed);
    return 2;
  }

  const first = planCloseCurrentWorkspace(deps.bridge(), deps.environment);
  if (first.status === "refused") {
    writeRefusal(deps, "preflight", first);
    return 2;
  }

  if (!mutate) {
    deps.stdout(JSON.stringify({ status: "authorized", dryRun: true, ...first.identity }));
    return 0;
  }

  const second = planCloseCurrentWorkspace(deps.bridge(), deps.environment);
  if (second.status === "refused") {
    writeRefusal(deps, "revalidation", second);
    return 2;
  }
  deps.stdout(JSON.stringify({ status: "closing", ...second.identity }));
  const result = deps.close(second.identity.workspaceId);
  if (!result.ok) {
    deps.stderr(JSON.stringify({ status: "close-failed", ...second.identity }));
    return 1;
  }
  deps.stdout(JSON.stringify({ status: "closed", ...second.identity }));
  return 0;
}
