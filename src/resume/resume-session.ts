/**
 * `ccs resume-session <id>` — the CORE resume operation (ADR-0015). Re-embody ONE identity:
 * if it's already open, skip (idempotent, no duplicate pane); else build `claude --resume
 * <id> [resume_command]` in the derived launch dir and spawn it in a cmux workspace.
 *
 * A loop (resume_command set) comes back RUNNING; a worker (no resume_command) gets a bare
 * resume and rehydrates from its inbox/state. `ccs resume-cluster` is a thin loop over this.
 *
 * Liveness is surface-keyed via the cmux bridge (ADR-0014/0040) — exact, no cwd/title guess.
 */
import type { Database } from "bun:sqlite";
import { sessionById, type SessionRow } from "../index/index.ts";
import type { Bridge } from "../cmux/bridge.ts";
import { liveBridge } from "../cmux/live.ts";
import { type RoleDef } from "../catalogue/db-schema.ts";
import { getRowBySessionOrResumeId, getAll, lifecycleOf } from "../catalogue/db-queries.ts";
import { isIncognito } from "../catalogue/incognito.ts";
import { identityKey } from "../catalogue/lineage.ts";
import { resolveRole } from "../roles/role-files.ts";
import { readClusterManifest, type ClusterManifest } from "../cluster/manifest.ts";
import { resolvePermissionMode } from "../roles/permission-mode.ts";
import { buildResumeCommand, resolveResumeCwd, type ResumeCommand } from "./command.ts";
import { spawnCmux, spawnCmuxAsync } from "./spawn-cmux.ts";
import type { AsyncProcessAdapter } from "../process/async.ts";
import { pushRenderOps } from "../catalogue/sync-tabs.ts";
import {
  DEFAULT_LAUNCHERS,
  defaultRoute,
  launcherByName,
  launcherEnvironment,
  resolveRoutes,
  type Launcher,
} from "./launchers.ts";

/** Just the catalogue bits resume needs (kept narrow so the planner is easy to test). */
export interface ResumeMeta {
  resumeCommand: string | null;
  /** Operating posture re-asserted because restored session state/settings cannot enforce it. */
  permissionMode?: string | null;
  /** One-shot trailing prompt supplied by the caller; overrides the role's recurring command. */
  prompt?: string;
  /** Launcher executable for argv[0]; null → plain `claude`. */
  binary?: string | null;
  /** Launcher env for the spawned process. */
  env?: Readonly<Record<string, string>>;
  /** Launcher `clears` — inherited variables removed before `env` applies. */
  unset?: readonly string[];
}

export type ResumePlan =
  | { action: "skip"; reason: "already-open" }
  | { action: "resume"; sessionId: string; command: ResumeCommand; name: string; note: string | null }
  | { action: "fail"; reason: "cwd-unreadable"; error: string };

/** Is this session currently embodied? Check both the filename id and the resume id, since
 * cmux records the live Claude sessionId and either may match depending on how it was born. */
function sessionIsOpen(bridge: Bridge, row: SessionRow): boolean {
  return bridge.isOpen(row.resumeId) || bridge.isOpen(row.sessionId);
}

/** Pure planner: decide skip vs resume, and build the exact command. No I/O. */
export function planResumeSession(
  bridge: Bridge,
  row: SessionRow,
  meta: ResumeMeta | null,
): ResumePlan {
  if (sessionIsOpen(bridge, row)) {
    return { action: "skip", reason: "already-open" };
  }
  const cwdResult = resolveResumeCwd(row);
  if ("error" in cwdResult) {
    // FAIL CLOSED: filesystem error locating the launch dir (ADR-0066/0054).
    return { action: "fail", reason: "cwd-unreadable", error: cwdResult.error };
  }
  const { cwd, note } = cwdResult;
  const command = buildResumeCommand(row, {
    fork: false,
    cwd,
    resumeCommand: meta?.prompt ?? meta?.resumeCommand ?? null,
    permissionMode: meta?.permissionMode ?? null,
    binary: meta?.binary ?? undefined,
    env: meta?.env,
    unset: meta?.unset,
  });
  const name = row.title || row.sessionId;
  return { action: "resume", sessionId: row.sessionId, command, name, note };
}

export type ResumeSessionResult =
  /** `workspaceRef` is the cmux ref of the newly-spawned workspace (e.g. "workspace:44"); null
   * only on dry-run. Callers use it to act on the workspace IMMEDIATELY (pin, paint, focus)
   * without waiting for cmux to bind surface→sessionId — that binding happens later, once the
   * child claude fires its SessionStart hook, so a by-session lookup right after spawn misses. */
  | { status: "resumed"; note: string | null; workspaceRef: string | null }
  | { status: "already-open" }
  | { status: "not-indexed" }
  /** Completed sessions are terminal until the lifecycle is explicitly cleared. */
  | { status: "completed" }
  /** Sidebar-only guard: direct Claude resume of durable T3 provenance needs one-shot approval. */
  | { status: "t3-confirmation-required" }
  | { status: "spawn-failed" }
  /** The workspace opened, but Saved/Completed could not be cleared from the catalogue. */
  | { status: "reactivation-failed"; workspaceRef: string | null }
  /** liveness sources were unreadable — we fail closed and spawn nothing (ADR-0054) */
  | { status: "liveness-unreadable" }
  /** cwd location failed with I/O error — fail closed per ADR-0066 */
  | { status: "cwd-unreadable"; error: string }
  /** the requested (or default) launcher can't replay this session's model history */
  | { status: "route-ineligible"; reason: string }
  /** `--via` named a launcher that isn't in config */
  | { status: "unknown-launcher"; name: string }
  /** the chosen launcher's `env`/`clears` could not be compiled (bad key, unreadable secret) */
  | { status: "launcher-env-unresolvable"; name: string; error: string };

/**
 * Pick the launcher for a session's model history: `via` forces one by name (route
 * eligibility still enforced unless `force`); otherwise the origin-backend default route.
 * Pure — shared by resume-session, the CLI `routes` view, and the TUI picker.
 */
export function chooseLauncher(
  launchers: readonly Launcher[],
  models: readonly string[],
  opts: { via?: string; force?: boolean; lastModel?: string },
):
  | { ok: true; launcher: Launcher }
  | { ok: false; status: "unknown-launcher"; name: string }
  | { ok: false; status: "route-ineligible"; reason: string } {
  const lastModel = opts.lastModel ?? "";
  const routes = resolveRoutes(launchers, models, lastModel);
  if (opts.via) {
    const launcher = launcherByName(launchers, opts.via);
    if (!launcher) return { ok: false, status: "unknown-launcher", name: opts.via };
    const route = routes.find((r) => r.launcher.name === opts.via);
    if (route && !route.eligible && !opts.force) {
      return { ok: false, status: "route-ineligible", reason: route.reason ?? "ineligible" };
    }
    return { ok: true, launcher };
  }
  const def = defaultRoute(routes, models, lastModel);
  if (!def) {
    const subject = lastModel === "" ? models.join(", ") : lastModel;
    return {
      ok: false,
      status: "route-ineligible",
      reason: `no configured launcher serves [${subject}]`,
    };
  }
  return { ok: true, launcher: def.launcher };
}

/** Resume policy is deliberately fail-open: an unreadable definition must not strand history. */
function resolveRoleForResume(role: string, cluster: string | null): RoleDef | null {
  try {
    return resolveRole(role, cluster);
  } catch {
    return null;
  }
}

/** Cluster permission policy is advisory on resume when its manifest cannot be read or parsed. */
function readClusterManifestForResume(cluster: string): ClusterManifest | null {
  try {
    const manifest = readClusterManifest(cluster);
    return manifest.ok ? manifest.value : null;
  } catch {
    return null;
  }
}

/**
 * The full `ccs resume-session <id>` entry: resolve the row + its resume_command, plan, and
 * (unless dry-run) execute. `bridge` defaults to the live cmux state; injectable for tests.
 */
export interface ResumeSessionOptions {
  readonly dryRun?: boolean;
  readonly cmuxBin?: string;
  readonly bridge?: Bridge;
  readonly focus?: boolean;
  /** One-shot trailing prompt; takes precedence over the role/session recurring resume command. */
  readonly prompt?: string;
  /** Launcher name to resume through; default = origin-backend route from the model history. */
  readonly via?: string;
  /** Bypass route eligibility for an explicit `via` (loud override). */
  readonly force?: boolean;
  /** Configured launcher fleet; default = plain `claude` (byte-identical to pre-routes ccs). */
  readonly launchers?: readonly Launcher[];
  /** Internal shared lookup from resumeMany; defaults to a fail-open file read for one resume. */
  readonly roleLookup?: (role: string, cluster: string | null) => RoleDef | null;
  /** Internal shared lookup from resumeMany; defaults to a fail-open manifest read for one resume. */
  readonly clusterManifestLookup?: (cluster: string) => ClusterManifest | null;
  /** Clear Saved after a successful explicit resume. Bulk resume never selects Saved sessions. */
  readonly reactivateSaved?: (sessionId: string) => boolean;
  /**
   * Clear Completed after a resume the user explicitly confirmed. Absent, completed stays
   * terminal and the resume refuses — which is every path except a confirmed sidebar reopen.
   */
  readonly reactivateCompleted?: (sessionId: string) => boolean;
  /** Enforce T3 provenance before CCS spawns another resume runtime. Defaults on. */
  readonly guardT3DirectResume?: boolean;
  /** One-request approval; never persisted and never clears the durable T3 mark. */
  readonly resumeT3Anyway?: boolean;
}

export function isDirectCcsResume(command: ResumeCommand): boolean {
  // "Direct" means CCS is spawning another Claude Code runtime rather than focusing an existing
  // surface. Launcher wrappers (`claudex`, `claude-native`, gateway aliases) still execute this same
  // transcript resume and therefore need the same T3 provenance guard.
  return command.argv[1] === "--resume";
}

type PreparedResumeSession =
  | { readonly ready: false; readonly result: ResumeSessionResult }
  | {
    readonly ready: true;
    readonly plan: Extract<ResumePlan, { readonly action: "resume" }>;
    readonly saved: boolean;
    readonly completed: boolean;
    readonly catalogueSessionId: string;
  };

function prepareResumeSession(
  indexDb: Database,
  catalogueDb: Database,
  sessionId: string,
  opts: ResumeSessionOptions,
): PreparedResumeSession {
  const row = sessionById(indexDb, sessionId);
  if (!row) return { ready: false, result: { status: "not-indexed" } };

  const cat = getRowBySessionOrResumeId(catalogueDb, row.sessionId)
    ?? getRowBySessionOrResumeId(catalogueDb, row.resumeId);
  const bridge = opts.bridge ?? liveBridge();
  // FAIL CLOSED: if we can't read liveness we can't tell "already open" from "closed". Treating
  // unreadable as closed would re-spawn a session that's actually running → duplicate-fleet
  // runaway (ADR-0054). Abort instead — spawn nothing, report the reason.
  if (!bridge.readable) return { ready: false, result: { status: "liveness-unreadable" } };
  if (sessionIsOpen(bridge, row)) return { ready: false, result: { status: "already-open" } };
  const lifecycle = lifecycleOf(cat);
  if (lifecycle === "completed" && !opts.reactivateCompleted) {
    return { ready: false, result: { status: "completed" } };
  }
  const launchers = opts.launchers ?? DEFAULT_LAUNCHERS;
  const chosen = chooseLauncher(launchers, row.models, {
    via: opts.via,
    force: opts.force,
    lastModel: row.lastModel,
  });
  if (!chosen.ok) {
    return {
      ready: false,
      result: chosen.status === "unknown-launcher"
        ? { status: "unknown-launcher", name: chosen.name }
        : { status: "route-ineligible", reason: chosen.reason },
    };
  }
  const roleLookup = opts.roleLookup ?? resolveRoleForResume;
  const manifestLookup = opts.clusterManifestLookup ?? readClusterManifestForResume;
  const roleDef = cat?.role ? roleLookup(cat.role, cat.cluster) : null;
  const clusterManifest = cat?.cluster ? manifestLookup(cat.cluster) : null;
  const launcherEnv = launcherEnvironment(chosen.launcher);
  if (!launcherEnv.ok) {
    return {
      ready: false,
      result: {
        status: "launcher-env-unresolvable",
        name: chosen.launcher.name,
        error: launcherEnv.error.message,
      },
    };
  }
  const plan = planResumeSession(bridge, row, {
    resumeCommand: roleDef?.resumeCommand ?? cat?.resumeCommand ?? null,
    permissionMode: resolvePermissionMode(roleDef, clusterManifest),
    prompt: opts.prompt,
    binary: chosen.launcher.binary,
    env: launcherEnv.value.assign,
    unset: launcherEnv.value.unset,
  });
  if (plan.action === "skip") return { ready: false, result: { status: "already-open" } };
  if (plan.action === "fail") {
    return { ready: false, result: { status: "cwd-unreadable", error: plan.error } };
  }
  if (
    opts.guardT3DirectResume !== false
    && cat?.t3Associated === true
    && isDirectCcsResume(plan.command)
    && !opts.resumeT3Anyway
  ) {
    return { ready: false, result: { status: "t3-confirmation-required" } };
  }
  if (cat) warnLiveSiblings(catalogueDb, bridge, cat.sessionId, identityKey(cat));
  return {
    ready: true,
    plan,
    saved: lifecycle === "saved",
    completed: lifecycle === "completed",
    catalogueSessionId: cat?.sessionId ?? row.sessionId,
  };
}

export function resumeSessionEntry(
  indexDb: Database,
  catalogueDb: Database,
  sessionId: string,
  opts: ResumeSessionOptions = {},
): ResumeSessionResult {
  const prepared = prepareResumeSession(indexDb, catalogueDb, sessionId, opts);
  if (!prepared.ready) return prepared.result;
  if (opts.dryRun) return { status: "resumed", note: prepared.plan.note, workspaceRef: null };
  const ref = executeResumePlan(prepared.plan, { cmuxBin: opts.cmuxBin, focus: opts.focus });
  if (ref === null) return { status: "spawn-failed" };
  if (prepared.saved && !opts.reactivateSaved?.(prepared.catalogueSessionId)) {
    return { status: "reactivation-failed", workspaceRef: ref };
  }
  if (prepared.completed && !opts.reactivateCompleted?.(prepared.catalogueSessionId)) {
    return { status: "reactivation-failed", workspaceRef: ref };
  }
  return { status: "resumed", note: prepared.plan.note, workspaceRef: ref };
}

/** Non-blocking action-lane entry. Cosmetic paint is deliberately owned by its caller. */
export async function resumeSessionEntryAsync(
  indexDb: Database,
  catalogueDb: Database,
  sessionId: string,
  opts: ResumeSessionOptions = {},
  processAdapter?: AsyncProcessAdapter,
): Promise<ResumeSessionResult> {
  const prepared = prepareResumeSession(indexDb, catalogueDb, sessionId, opts);
  if (!prepared.ready) return prepared.result;
  if (opts.dryRun) return { status: "resumed", note: prepared.plan.note, workspaceRef: null };
  const ref = await spawnCmuxAsync({
    argv: prepared.plan.command.argv,
    cwd: prepared.plan.command.cwd,
    env: prepared.plan.command.env,
    unset: prepared.plan.command.unset,
    name: prepared.plan.name,
    focus: opts.focus,
    cmuxBin: opts.cmuxBin,
  }, processAdapter);
  if (ref === null) return { status: "spawn-failed" };
  if (prepared.saved && !opts.reactivateSaved?.(prepared.catalogueSessionId)) {
    return { status: "reactivation-failed", workspaceRef: ref };
  }
  if (prepared.completed && !opts.reactivateCompleted?.(prepared.catalogueSessionId)) {
    return { status: "reactivation-failed", workspaceRef: ref };
  }
  return { status: "resumed", note: prepared.plan.note, workspaceRef: ref };
}

/**
 * Execute a resume plan: spawn a new detached cmux workspace running the resume command (via the
 * shared spawnCmux primitive — same env-scrub as new-session, ADR-0042), then EAGERLY paint the
 * tab from the session's ccs metadata so it renders correct immediately, without waiting for the
 * spawned session's own SessionStart hook to boot and fire. The hook remains the steady-state
 * owner; this is just the first paint. Best-effort: a paint miss (cmux may not have registered
 * the new surface yet) is harmless — the hook repaints on boot.
 */
/**
 * Warn (never block) when OTHER live sessions share the identity we're about to resume (ADR-0073).
 * Duplicate embodiment is tolerated — MRU resume + atomic drain make it harmless — but a lingering
 * twin is worth flagging so the operator/control can close it. Best-effort: catalogue-only scan
 * against the same liveness bridge; any error is swallowed (a warning must never fail a resume).
 */
function warnLiveSiblings(catalogueDb: Database, bridge: Bridge, selfId: string, key: string | null): void {
  if (!key) return; // no identity-key (no role/work-unit) → nothing to compare
  try {
    const siblings: string[] = [];
    for (const [sid, row] of getAll(catalogueDb)) {
      if (sid === selfId) continue;
      if (isIncognito(row)) continue; // this warning prints session ids; an incognito twin stays unnamed
      const lc = lifecycleOf(row);
      if (lc === "completed" || lc === "archived" || lc === "saved") continue; // inactive can't be a live twin
      if (identityKey(row) !== key) continue;
      if (bridge.isOpen(sid) || (row.resumeId && bridge.isOpen(row.resumeId))) siblings.push(sid);
    }
    if (siblings.length > 0) {
      const shown = siblings.slice(0, 5).map((s) => s.slice(0, 8)).join(", ");
      const more = siblings.length > 5 ? `, +${siblings.length - 5} more` : "";
      console.warn(
        `ccs: ${siblings.length} other live session(s) share identity "${key}" (${shown}${more}). ` +
          `Resuming the most-recently-used one; close the stale twin(s) if unwanted (ccs won't).`,
      );
    }
  } catch {
    /* warning is best-effort — never let it block a resume */
  }
}

export function executeResumePlan(
  plan: ResumePlan,
  opts: { cmuxBin?: string; focus?: boolean } = {},
): string | null {
  if (plan.action === "skip" || plan.action === "fail") return null;
  const ref = spawnCmux({
    argv: plan.command.argv,
    cwd: plan.command.cwd,
    env: plan.command.env,
    unset: plan.command.unset,
    name: plan.name,
    focus: opts.focus,
    cmuxBin: opts.cmuxBin,
  });
  if (ref === null) return null;
  try {
    // Paint the JUST-CREATED workspace by its ref — cmux hasn't bound surface→sessionId yet, so a
    // by-session lookup would miss. The hook repaints on boot regardless.
    pushRenderOps(plan.sessionId, opts.cmuxBin, ref);
  } catch {
    /* eager paint is best-effort; the SessionStart hook repaints on boot */
  }
  return ref;
}
