import { execFileSync } from "node:child_process";
import type { Bridge, SurfaceLocation } from "./bridge.ts";
import { liveBridge } from "./live.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSE_TIMEOUT_MS = 5_000;

type Awaitable<T> = T | Promise<T>;

export interface CurrentWorkspaceEnvironment {
  CLAUDE_CODE_SESSION_ID?: string;
  CMUX_SURFACE_ID?: string;
  CMUX_WORKSPACE_ID?: string;
}

export interface CurrentWorkspaceIdentity {
  readonly sessionId: string;
  readonly surfaceId: string;
  readonly workspaceId: string;
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
  | "shared-workspace"
  | "ambiguous-session-target";

export type ClosePlan =
  | { readonly status: "authorized"; readonly identity: CurrentWorkspaceIdentity }
  | { readonly status: "refused"; readonly reason: CloseRefusalReason };

export interface CloseAttempt {
  readonly ok: boolean;
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

export interface CloseSessionWorkspaceDependencies {
  bridge(): Awaitable<Bridge>;
  close(workspaceId: string, location: SurfaceLocation): Awaitable<CloseAttempt>;
}

export type CloseSessionWorkspaceOutcome =
  | {
    readonly status: "authorized";
    readonly dryRun: true;
    readonly identity: CurrentWorkspaceIdentity;
  }
  | {
    readonly status: "refused";
    readonly phase: "preflight" | "revalidation";
    readonly reason: CloseRefusalReason;
  }
  | { readonly status: "close-failed"; readonly identity: CurrentWorkspaceIdentity }
  | { readonly status: "closed"; readonly identity: CurrentWorkspaceIdentity };

function requiredUuid(
  value: string | undefined,
  missing: CloseRefusalReason,
  invalid: CloseRefusalReason,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: CloseRefusalReason } {
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
 * Authorize an already-resolved stable identity. Every join is UUID based. Missing, stale, shared,
 * or contradictory state refuses instead of falling back to numeric cmux refs.
 */
function planCloseWorkspaceIdentity(
  bridge: Bridge,
  identity: CurrentWorkspaceIdentity,
): ClosePlan {
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

/**
 * Authorize closing only the exact cmux workspace occupied and owned by the current Claude session.
 * The environment supplies all three stable UUIDs, retaining the original current-workspace proof.
 */
export function planCloseCurrentWorkspace(
  bridge: Bridge,
  environment: CurrentWorkspaceEnvironment,
): ClosePlan {
  const parsed = currentWorkspaceIdentity(environment);
  if (parsed.status === "refused") return parsed;
  return planCloseWorkspaceIdentity(bridge, parsed.identity);
}

/**
 * Resolve an explicit session to its live surface through the bridge, then authorize that exact
 * stable surface/workspace identity. No current-session environment or numeric cmux ref is used.
 */
export function planCloseSessionWorkspace(bridge: Bridge, sessionId: string): ClosePlan {
  const parsed = requiredUuid(sessionId, "missing-session-id", "invalid-session-id");
  if (!parsed.ok) return { status: "refused", reason: parsed.reason };
  if (!bridge.readable) return { status: "refused", reason: "bridge-unreadable" };

  const location = bridge.locateSession(parsed.value);
  if (!location) return { status: "refused", reason: "session-not-live" };
  const surface = requiredUuid(location.surfaceId, "missing-surface-id", "invalid-surface-id");
  if (!surface.ok) return { status: "refused", reason: surface.reason };
  const workspace = requiredUuid(
    location.workspaceId,
    "missing-workspace-id",
    "invalid-workspace-id",
  );
  if (!workspace.ok) return { status: "refused", reason: workspace.reason };
  return planCloseWorkspaceIdentity(bridge, {
    sessionId: parsed.value,
    surfaceId: surface.value,
    workspaceId: workspace.value,
  });
}

/**
 * Resolve canonical/resume aliases in one bridge snapshot. Exactly one live stable identity may
 * win; two different live bodies refuse rather than guessing which session the caller meant.
 */
export function planCloseSessionWorkspaceCandidates(
  bridge: Bridge,
  sessionIds: readonly string[],
): ClosePlan {
  const candidates = [...new Set(sessionIds)];
  if (candidates.length === 0) return { status: "refused", reason: "missing-session-id" };
  if (!bridge.readable) return { status: "refused", reason: "bridge-unreadable" };

  const authorized = new Map<string, Extract<ClosePlan, { readonly status: "authorized" }>>();
  for (const sessionId of candidates) {
    const parsed = requiredUuid(sessionId, "missing-session-id", "invalid-session-id");
    if (!parsed.ok) return { status: "refused", reason: parsed.reason };
    if (!bridge.locateSession(parsed.value)) continue;

    const plan = planCloseSessionWorkspace(bridge, parsed.value);
    if (plan.status === "refused") return plan;
    authorized.set(`${plan.identity.surfaceId}:${plan.identity.workspaceId}`, plan);
  }

  if (authorized.size === 0) return { status: "refused", reason: "session-not-live" };
  if (authorized.size > 1) return { status: "refused", reason: "ambiguous-session-target" };
  const selected = authorized.values().next().value;
  return selected ?? { status: "refused", reason: "session-not-live" };
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

/** Execute the stable-UUID cmux close used after the primitive has authorized a workspace. */
export function closeWorkspaceByStableIdWithCmux(
  cmuxBin: string,
  workspaceId: string,
): CloseAttempt {
  return closeWorkspaceByStableId(productionRunner, cmuxBin, workspaceId);
}

function productionSessionDependencies(): CloseSessionWorkspaceDependencies {
  const cmuxBin = process.env.CMUX_BIN ?? "cmux";
  return {
    bridge: () => liveBridge(cmuxBin),
    close: (workspaceId) => closeWorkspaceByStableIdWithCmux(cmuxBin, workspaceId),
  };
}

/**
 * Close one of a session's explicit ids after two fresh bridge proofs. The second proof is against
 * the first proof's stable surface/workspace UUIDs, so reattach or renumbering drift refuses.
 */
export async function closeSessionWorkspaceCandidates(
  sessionIds: readonly string[],
  mutate: boolean,
  deps: CloseSessionWorkspaceDependencies = productionSessionDependencies(),
): Promise<CloseSessionWorkspaceOutcome> {
  const firstBridge = await deps.bridge();
  const first = planCloseSessionWorkspaceCandidates(firstBridge, sessionIds);
  if (first.status === "refused") {
    return { status: "refused", phase: "preflight", reason: first.reason };
  }

  if (!mutate) return { status: "authorized", dryRun: true, identity: first.identity };

  const secondBridge = await deps.bridge();
  const second = planCloseWorkspaceIdentity(secondBridge, first.identity);
  if (second.status === "refused") {
    return { status: "refused", phase: "revalidation", reason: second.reason };
  }

  const location = secondBridge.surfaceToWorkspace.get(second.identity.surfaceId);
  if (!location) {
    return { status: "refused", phase: "revalidation", reason: "surface-not-live" };
  }
  const result = await deps.close(second.identity.workspaceId, location);
  if (!result.ok) return { status: "close-failed", identity: second.identity };
  return { status: "closed", identity: second.identity };
}

/** Close one explicit session id; convenience wrapper over the alias-safe general form. */
export function closeSessionWorkspace(
  sessionId: string,
  mutate: boolean,
  deps?: CloseSessionWorkspaceDependencies,
): Promise<CloseSessionWorkspaceOutcome> {
  return closeSessionWorkspaceCandidates([sessionId], mutate, deps);
}

function productionCurrentDependencies(): CloseCurrentWorkspaceDependencies {
  const cmuxBin = process.env.CMUX_BIN ?? "cmux";
  return {
    environment: {
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
      CMUX_SURFACE_ID: process.env.CMUX_SURFACE_ID,
      CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
    },
    bridge: () => liveBridge(cmuxBin),
    close: (workspaceId) => closeWorkspaceByStableIdWithCmux(cmuxBin, workspaceId),
    stdout: console.log,
    stderr: console.error,
  };
}

function writeRefusal(
  deps: CloseCurrentWorkspaceDependencies,
  phase: "preflight" | "revalidation",
  plan: Extract<ClosePlan, { readonly status: "refused" }>,
): void {
  deps.stderr(JSON.stringify({ status: "refused", phase, reason: plan.reason }));
}

/** `ccs close-current-workspace [--do]`: dry-run by default; mutation requires two proofs. */
export function closeCurrentWorkspaceCommand(
  args: string[],
  deps: CloseCurrentWorkspaceDependencies = productionCurrentDependencies(),
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
