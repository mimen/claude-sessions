/**
 * Replacing a LIVE session's process in place, without closing anything.
 *
 * The primitive is `cmux respawn-pane`: it SIGHUPs whatever the surface is running and starts the
 * given command in its place. The workspace, tab, title, dock slot, CCS catalogue row and surface
 * UUID all survive, because nothing is ever closed. It needs no watcher — cmux performs the
 * restart, so the new process outliving the caller is cmux's problem, not ours, which matters
 * because the caller IS the process being replaced. And it never routes through resume-session,
 * so already-open / not-indexed / route-ineligible have no say; a session mid-flight is exactly
 * the case those three refuse.
 *
 * Two commands sit on this: `swap-harness` (relaunch on the OTHER launcher) and `restart`
 * (relaunch on the SAME one). Everything here is pure except `runRespawn`, so the identity proofs
 * are testable without cmux.
 */
import type { Bridge, SurfaceSession } from "../cmux/bridge.ts";
import { type Result, err, ok } from "../result.ts";
import { shellQuote } from "./command.ts";
import { defaultRoute, matchesModel, resolveRoutes, type Launcher } from "./launchers.ts";
import { ROLE_MODEL_IDS, compileRoleModelValue } from "./role-model-launch.ts";

/** Process-side facts a plan is built from — all injected so planning stays pure. */
export interface RespawnEnv {
  /** CLAUDE_CODE_SESSION_ID — the session asking to be replaced. */
  readonly sessionId: string | null;
  /** CMUX_SURFACE_ID — the surface it believes it occupies. */
  readonly surfaceId: string | null;
  /** CMUX_WORKSPACE_ID, when the process has one. */
  readonly workspaceId: string | null;
}

/** A session's model history, as the index knows it. */
export interface ModelHistory {
  readonly models: readonly string[];
  readonly lastModel: string;
}

export type RespawnRefusalCode =
  | "not-in-session"
  | "not-in-surface"
  | "liveness-unreadable"
  | "surface-unbound"
  | "identity-mismatch"
  | "workspace-mismatch"
  | "cwd-unknown"
  | "unknown-launcher"
  | "origin-unknown"
  | "ambiguous-target"
  | "same-harness"
  | "model-unknown";

export interface RespawnRefusal {
  readonly code: RespawnRefusalCode;
  readonly message: string;
}

export const refuse = (code: RespawnRefusalCode, message: string): Result<never, RespawnRefusal> =>
  err({ code, message });

export interface RespawnPlan {
  readonly sessionId: string;
  readonly surfaceId: string;
  /**
   * The harness the session is currently on, inferred from its model history — null when the
   * history can't say (no assistant turns yet, or not indexed). Naming an origin we only guessed
   * at would be worse than admitting we don't know.
   */
  readonly from: Launcher | null;
  /** The harness it will come back on. Equal to `from` for a restart. */
  readonly to: Launcher;
  /** null means "pass no --model", letting the new process re-resolve from settings. */
  readonly model: string | null;
  readonly cwd: string;
  readonly permissionMode: string | null;
  /** The pid cmux will hang up, recorded so the caller can report what it replaced. */
  readonly pid: number | null;
  /** Exact shell string for `cmux respawn-pane --command`. */
  readonly command: string;
}

/** What the identity proof establishes: this surface really is this session's. */
export interface ProvenSurface {
  readonly sessionId: string;
  readonly surfaceId: string;
  readonly bound: SurfaceSession;
  readonly cwd: string;
}

/**
 * Prove the caller is who it claims to be.
 *
 * This is the whole safety story: a respawn hangs up a live process, so aiming it at the wrong
 * surface would kill an unrelated session. The environment's session id and surface id must AGREE
 * with cmux's own binding — trusting either alone is what `close-current-workspace` refuses to do,
 * for the same reason.
 */
export function proveSurface(
  env: RespawnEnv,
  bridge: Bridge,
  resumeCwd: string | undefined,
): Result<ProvenSurface, RespawnRefusal> {
  if (!env.sessionId) {
    return refuse("not-in-session", "no CLAUDE_CODE_SESSION_ID — run this from inside the session");
  }
  if (!env.surfaceId) {
    return refuse("not-in-surface", "no CMUX_SURFACE_ID — this session is not running in a cmux surface");
  }
  // FAIL CLOSED (ADR-0054): unreadable liveness cannot be told apart from "nothing is bound", and
  // guessing here hangs up a process we never identified.
  if (!bridge.readable) {
    return refuse("liveness-unreadable", "cmux liveness is unreadable — refusing to respawn blind");
  }

  const bound = bridge.surfaceInfo(env.surfaceId);
  if (!bound) return refuse("surface-unbound", `cmux has no session bound to surface ${env.surfaceId}`);
  if (bound.sessionId !== env.sessionId) {
    return refuse(
      "identity-mismatch",
      `surface ${env.surfaceId} is bound to ${bound.sessionId}, not ${env.sessionId}`,
    );
  }
  if (env.workspaceId && bound.workspaceId && env.workspaceId !== bound.workspaceId) {
    return refuse(
      "workspace-mismatch",
      `env workspace ${env.workspaceId} disagrees with cmux's ${bound.workspaceId}`,
    );
  }

  // The cwd MUST come from the transcript's storage folder, never from cmux's recorded cwd.
  // cmux's hooks track where the session currently IS, which drifts as the agent works — a session
  // launched in a repo and later cd'd into one of its worktrees has a hook-store cwd pointing at
  // the worktree while its transcript stays filed under the launch dir. Relaunching from the
  // drifted dir makes Claude Code search the wrong `~/.claude/projects/<encoded>` and fail with
  // "No conversation found with session ID".
  if (!resumeCwd) {
    return refuse(
      "cwd-unknown",
      "could not resolve this session's launch directory from its transcript — refusing to relaunch where `--resume` would not find it",
    );
  }

  return ok({ sessionId: env.sessionId, surfaceId: env.surfaceId, bound, cwd: resumeCwd });
}

/**
 * The launcher a session is currently on, inferred from its model history — null when the history
 * carries no signal. `defaultRoute` would still answer for an empty history (everything is
 * eligible, so config order wins), which would be a guess wearing an answer's clothes, and this is
 * a common state: a session is respawnable long before it is indexed.
 */
export function originLauncher(
  launchers: readonly Launcher[],
  history: ModelHistory,
): Launcher | null {
  if (history.lastModel === "" && history.models.length === 0) return null;
  const routes = resolveRoutes(launchers, history.models, history.lastModel);
  return defaultRoute(routes, history.models, history.lastModel)?.launcher ?? null;
}

/**
 * Validate a user-authored canonical model through the birth-model compiler, then return the
 * launcher spelling. Canonical IDs remain provider-neutral at the boundary; GPT's required `[1m]`
 * suffix is compiler-owned and appears only in the executable plan.
 */
export function compileRespawnModel(
  model: string,
  target: Launcher,
): Result<string, RespawnRefusal> {
  const compiled = compileRoleModelValue(model);
  if (!compiled) {
    return refuse(
      "model-unknown",
      `unknown model "${model}" — canonical models: ${ROLE_MODEL_IDS.join(", ")}`,
    );
  }
  if (!target.serves.some((pattern) => matchesModel(pattern, compiled.model))) {
    return refuse(
      "model-unknown",
      `model "${model}" is not served by launcher "${target.name}"`,
    );
  }
  return ok(compiled.launchModel);
}

/**
 * The shell string cmux runs in the respawned surface.
 *
 * Deliberately NOT `exec`: cmux's `claude` shim has to wrap the process for its hooks to register
 * the new session against the surface (see spawn-cmux.ts). Running it as a plain command keeps
 * that wrapping intact, which is what keeps the session visible to ccs afterwards.
 *
 * A null `model` omits `--model` entirely, so the new process resolves whatever the settings alias
 * currently points at. That is the difference between a restart that picks up a newly released
 * model and one that pins you to yesterday's.
 */
export function buildRespawnCommand(opts: {
  readonly cwd: string;
  readonly binary: string;
  readonly sessionId: string;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly env?: Readonly<Record<string, string>>;
}): string {
  const argv = [opts.binary, "--resume", opts.sessionId];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.permissionMode) argv.push("--permission-mode", opts.permissionMode);
  const entries = Object.entries(opts.env ?? {});
  const prefix = entries.length
    ? `env ${entries.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ")} `
    : "";
  return `cd -- ${shellQuote(opts.cwd)} && ${prefix}${argv.map(shellQuote).join(" ")}`;
}

/** Assemble a plan once the target harness and model are settled. */
export function respawnPlan(
  proven: ProvenSurface,
  from: Launcher | null,
  to: Launcher,
  model: string | null,
): RespawnPlan {
  return {
    sessionId: proven.sessionId,
    surfaceId: proven.surfaceId,
    from,
    to,
    model,
    cwd: proven.cwd,
    permissionMode: proven.bound.lastPermissionMode,
    pid: proven.bound.pid,
    command: buildRespawnCommand({
      cwd: proven.cwd,
      binary: to.binary,
      sessionId: proven.sessionId,
      model,
      permissionMode: proven.bound.lastPermissionMode,
      env: to.env,
    }),
  };
}

/** Injected so a respawn is testable without hanging up a real session. */
export interface RespawnIo {
  respawn(surfaceId: string, command: string): { ok: true } | { ok: false; error: string };
}

/**
 * Execute a plan. Returns once cmux ACKNOWLEDGES the request — not once the new process is up,
 * which the caller is in no position to observe, being the process cmux is about to hang up.
 */
export function runRespawn(plan: RespawnPlan, io: RespawnIo): Result<RespawnPlan, RespawnRefusal> {
  const res = io.respawn(plan.surfaceId, plan.command);
  if (!res.ok) return err({ code: "liveness-unreadable", message: res.error });
  return ok(plan);
}

/** Human-readable preflight, printed before `--do` and on refusal. */
export function describeRespawn(plan: RespawnPlan, headline: string): string {
  const lines = [
    headline,
    `  model:      ${plan.model ?? "(settings default — re-resolved on start)"}`,
    `  cwd:        ${plan.cwd}`,
    `  surface:    ${plan.surfaceId}`,
    `  permission: ${plan.permissionMode ?? "(harness default)"}`,
  ];
  if (plan.pid !== null) lines.push(`  replaces:   pid ${plan.pid} (SIGHUP via cmux respawn-pane)`);
  lines.push(`  command:    ${plan.command}`);
  return lines.join("\n");
}
