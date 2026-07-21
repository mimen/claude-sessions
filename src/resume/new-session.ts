import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import type { Database } from "bun:sqlite";
import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";
import {
  openCatalogue,
  setCustomTitle,
  setKey,
  setParent,
  setSessionClass,
  setRole,
  setProject,
  setCluster,
  setResumeId,
  setGusWork,
  setWorkUnitId,
  setArchived,
  setMeta,
  getRow,
  lifecycleOf,
  sessionsForWorkUnit,
  stampPrFacts,
  type RoleDef,
} from "../catalogue/db.ts";
import pkg from "../../package.json" with { type: "json" };
import { resolveWorkUnit } from "../catalogue/resolve-work-unit.ts";
import { getIdentity } from "../catalogue/identities.ts";
import { resolveRole } from "../roles/role-files.ts";
import { checkClusterGate } from "../cluster/manifest.ts";
import { shellQuote } from "./command.ts";
import { spawnCmux } from "./spawn-cmux.ts";
import { execFileSync } from "node:child_process";
import { spawnContractError, type SpawnFacts, type WorktreeState } from "../catalogue/spawn-contract.ts";
import { interpretSpawnLocation, syntheticRow, type SpawnLocationConfig } from "../catalogue/spawn-location.ts";
import { resolveConfig } from "../hooks/resolve-config.ts";
import { liveResolveCtx } from "../hooks/compose-claude-md.ts";
import { runSpawnActions } from "../hooks/spawn-actions.ts";

/**
 * `ccs new-session` — mint a session id, bind its catalogue metadata AT BIRTH, then either
 * launch `claude --session-id <id>` or just print the id for an external launcher.
 *
 * Why this exists: metadata (system / role / kind / phase / …) used to be stapled on AFTER a
 * session already existed — by a Stop hook, by catalogue_sync, or by hand — which meant a
 * just-spawned session had no identity until something noticed it (the O5/"role-based hooks"
 * gap). Because Claude Code lets us CHOOSE the id up front (`claude --session-id <uuid>`),
 * we can mint it here, write the metadata keyed to that id (a forward reference — the row
 * exists before the session is ever indexed), and only THEN launch. Identity is correct from
 * the first turn, and can never be mis-guessed from an external cwd/title.
 *
 * Two modes (see the M3 decision):
 *   - default: mint + LAUNCH `claude --session-id <id> [<prompt>]` in the cwd, inheriting the
 *     TTY (interactive — the human lands in the session). This is the main path.
 *   - `--print-id`: mint + write metadata, print ONLY the id to stdout, do NOT launch. The
 *     fleet launcher (spawn-agent.sh / cmux) takes the id and does its own headless spawn with
 *     `claude --session-id <that id>`. Keeps ccs out of cmux/process management.
 */

export interface NewSessionOpts {
  cluster?: string;
  /** A pre-minted durable identity to attach at session birth. */
  identity?: string;
  /** The session's role — the canonical identity axis (ADR-0015). */
  role?: string;
  /** How a loop is re-armed on resume — DERIVED from the role's role.toml at launch (ADR-0062),
   * not a per-session flag. Populated internally from roleDef; used only for launch (prompt +
   * permission mode), never stored (kind/resume_command columns dropped v29). */
  resumeCommand?: string;
  project?: string;
  key?: string;
  title?: string;
  parent?: string;
  /** Required birth declaration: independent work body versus causal auxiliary child. */
  topLevel?: boolean;
  childOf?: string;
  /** Work-item id (W-number) — stamped at birth so the statusline/tab link the ticket from
   * turn one (ADR-0027), before any later git/PR sense tick. */
  gusWork?: string;
  /** PR facts known at spawn (the fleet already has repo + number in hand). Stamped at birth
   * so the clickable PR link is present immediately — no gap until the next sense tick. */
  prNumber?: number;
  prRepo?: string;
  cwd?: string;
  prompt?: string;
  /** Passed through to `claude --permission-mode <mode>` when launching. */
  permissionMode?: string;
  /** Reserve mode: write metadata + print the id, don't launch. */
  printId: boolean;
  /** Escape hatch: launch INLINE in the current terminal (Bun.spawnSync, inherits this
   * surface). Default is DETACHED into a fresh cmux workspace — inline hijacks the caller's
   * CMUX_SURFACE_ID and rebinds their tab to the new session (ADR-0042). */
  inline: boolean;
}

/** Parse a --pr-number value to a positive integer, or undefined (0 / non-numeric = "no PR yet"). */
function prNumberFrom(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const VALUE_FLAGS = new Set([
  "--cluster", "--identity", "--role", "--skill", "--project", "--key", "--title", "--parent", "--child-of",
  "--gus-work", "--pr-number", "--pr-repo", "--cwd", "--prompt", "--permission-mode",
]);
const BOOLEAN_FLAGS = new Set(["--print-id", "--top-level", "--inline"]);

interface ParsedOptions {
  values: Map<string, string>;
  booleans: Set<string>;
}

/** Parse known options in order so text supplied to another flag is never reinterpreted as a flag. */
function parseOptions(args: string[]): ParsedOptions {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    if (VALUE_FLAGS.has(flag)) {
      if (equals !== -1) {
        values.set(flag, token.slice(equals + 1));
        continue;
      }
      const value = args[index + 1];
      // Prompts are free-form and may intentionally begin with `--`; all other option values use
      // the conventional non-flag token form so a missing value does not swallow the next option.
      if (value !== undefined && (flag === "--prompt" || !value.startsWith("--"))) {
        values.set(flag, value);
        index++;
      }
      continue;
    }
    if (BOOLEAN_FLAGS.has(token)) booleans.add(token);
  }
  return { values, booleans };
}

function normalizedRole(role: string): string {
  return role.replace(/^\//, "");
}

export function parseOpts(args: string[]): NewSessionOpts {
  const { values, booleans } = parseOptions(args);
  return {
    cluster: values.get("--cluster"),
    identity: values.get("--identity"),
    // `--role` reads best for the fleet ("this is a pr-agent"); `--skill` is accepted as a synonym.
    // ADR-0062: --kind and --resume-command are retired — kind + re-arm derive from the role's
    // role.toml now (a role with a resume_command IS a loop), not per-session flags/columns.
    role: values.get("--role") ?? values.get("--skill"),
    project: values.get("--project"),
    key: values.get("--key"),
    title: values.get("--title"),
    parent: values.get("--parent"),
    childOf: values.get("--child-of"),
    gusWork: values.get("--gus-work"),
    prNumber: prNumberFrom(values.get("--pr-number")),
    prRepo: values.get("--pr-repo"),
    cwd: values.get("--cwd"),
    prompt: values.get("--prompt"),
    permissionMode: values.get("--permission-mode"),
    printId: booleans.has("--print-id"),
    topLevel: booleans.has("--top-level"),
    inline: booleans.has("--inline"),
  };
}

/** Validate explicit-birth flags that must not be filled by role defaults. */
function validateExplicitIdentityFlags(opts: NewSessionOpts): string | null {
  if (!opts.identity) return null;
  if (opts.key) return "--identity cannot be combined with legacy --key";
  if (!opts.cluster) return "--identity requires --cluster";
  if (!opts.role) return "--identity requires --role";
  if (opts.gusWork || opts.prRepo || opts.prNumber) {
    return "--identity cannot be combined with legacy --pr-repo, --pr-number, or --gus-work";
  }
  return null;
}

/** Validate a pre-minted identity birth request before a session id or row is created. */
export function validateExplicitIdentityBirth(db: Database, opts: NewSessionOpts): string | null {
  const flagsError = validateExplicitIdentityFlags(opts);
  if (flagsError) return flagsError;
  const identityKey = opts.identity;
  if (!identityKey) return null;

  const cluster = opts.cluster;
  const roleArg = opts.role;
  if (!cluster || !roleArg) return "--identity requires --cluster and --role";
  const identity = getIdentity(db, identityKey);
  if (!identity) return `identity '${identityKey}' does not exist — mint it first with \`ccs identity mint\``;
  const role = normalizedRole(roleArg);
  if (identity.cluster !== cluster) {
    return `identity '${identityKey}' belongs to cluster '${identity.cluster}', not '${cluster}'`;
  }
  if (identity.role !== role) {
    return `identity '${identityKey}' belongs to role '${identity.role}', not '${role}'`;
  }
  return null;
}

/** Validate causal launch intent before a UUID or catalogue row is created. */
export function resolveLaunchIntent(opts: NewSessionOpts, _args: readonly string[] = []): string | null {
  if (opts.parent !== undefined) return "--parent is repair-only; use --child-of for a new session";
  const hasChild = opts.childOf !== undefined;
  if (opts.topLevel === hasChild) return "require exactly one of --top-level or --child-of <uuid|.>";
  if (opts.topLevel) return null;
  if (!opts.childOf) return "--child-of requires a parent UUID or .";
  const parent = opts.childOf === "." ? process.env.CLAUDE_CODE_SESSION_ID : opts.childOf;
  if (!parent) return "--child-of . requires CLAUDE_CODE_SESSION_ID";
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parent)) return "--child-of must be a UUID or .";
  opts.parent = parent;
  return null;
}

/**
 * Write every provided metadatum for `id` into `db`, all stamped `now`. The row is created if
 * absent (a forward reference — the session isn't indexed yet). The entire metadata bundle is
 * transactional, so an explicit birth never leaves a partially registered session behind.
 */
export function writeSessionMetadata(db: Database, id: string, opts: NewSessionOpts, now: string): void {
  const explicitError = validateExplicitIdentityBirth(db, opts);
  if (explicitError) throw new Error(explicitError);
  db.transaction(() => writeSessionMetadataTransaction(db, id, opts, now))();
}

function writeSessionMetadataTransaction(db: Database, id: string, opts: NewSessionOpts, now: string): void {
  // The session id doubles as the resume handle when launched with `--session-id`, so record
  // it now — `ccs resume` can then revive the session even before it's indexed.
  setResumeId(db, id, id, now);
  // ADR-0089 v33: mint the identity + link the session. Identity carries every identity-
  // relevant field; the legacy per-session setters below are no-ops that stamp updated_at.
  const role = opts.role ? normalizedRole(opts.role) : null;
  if (opts.identity) {
    // Explicit birth attaches only to the pre-validated identity. It never derives an anchor,
    // mints an identity, populates PR/GUS attrs, or supersedes sibling embodiments.
    db.query("UPDATE catalogue SET identity_key = $k, updated_at = $now WHERE session_id = $id").run({
      $k: opts.identity,
      $now: now,
      $id: id,
    });
  } else if (opts.cluster && role) {
    const workRef =
      opts.prRepo && opts.prNumber ? `${opts.prRepo}#${opts.prNumber}` :
      opts.gusWork ? opts.gusWork : null;
    const identityKey = workRef ? `${opts.cluster}:${role}:${workRef}` : `${opts.cluster}:${role}`;
    // Lazy require to keep new-session lean at import time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mintIdentity, setIdentityFields } = require("../catalogue/identities.ts");
    mintIdentity(db, identityKey, { cluster: opts.cluster, role }, now);
    // Attach the session.
    db.query("UPDATE catalogue SET identity_key = $k, updated_at = $now WHERE session_id = $id").run({
      $k: identityKey,
      $now: now,
      $id: id,
    });
    // Fill in per-role attrs when known at spawn.
    const attrs: Record<string, unknown> = {};
    if (opts.prRepo) attrs.pr_repo = opts.prRepo;
    if (opts.prNumber) attrs.pr_number = opts.prNumber;
    if (opts.gusWork) attrs.gus_work = opts.gusWork;
    if (Object.keys(attrs).length > 0) {
      try {
        setIdentityFields(db, identityKey, attrs, now);
      } catch {
        // Per-role table may not be materialized (test env without config root) — non-fatal.
      }
    }
  }
  // Legacy setters — no-ops on the dropped columns, but they still touch updated_at and
  // remain called so any future non-dropped column extensions route through the same path.
  if (opts.cluster) setCluster(db, id, opts.cluster, now);
  if (role) setRole(db, id, role, now);
  if (opts.project) setProject(db, id, opts.project, now);
  if (opts.key) setKey(db, id, opts.key, now);
  if (opts.title) setCustomTitle(db, id, opts.title, now);
  if (opts.parent) setParent(db, id, opts.parent, now);
  setSessionClass(db, id, opts.topLevel ? "work_body" : opts.parent ? "auxiliary" : null, now);
  if (opts.gusWork) setGusWork(db, id, opts.gusWork, now);
  if (opts.prNumber && opts.prRepo) {
    stampPrFacts(db, id, { prNumber: opts.prNumber, prRepo: opts.prRepo, prBranch: "", prState: "open", prHeadSha: "" }, now);
  }
  // ADR-0057: resolve-or-mint the work-unit ENTITY this session belongs to, and FK the row to it.
  // The work-unit lives in cluster state, so this only applies to a cluster-scoped session with an
  // anchor (PR/GUS). find-or-create: a second spawn for the same PR reconnects to the same id
  // (the dedup/lineage foundation). Best-effort — a work-unit-store failure never blocks the spawn.
  if (!opts.identity && opts.cluster && (opts.gusWork || (opts.prNumber && opts.prRepo))) {
    try {
      // ADR-0069: dispatch on the role's declared anchor type (a core role — work_unit "none" —
      // owns no work-unit, so skip). Undeclared roles infer PR-then-GUS (resolver default).
      const anchorType = opts.role ? resolveRole(opts.role.replace(/^\//, ""), opts.cluster ?? null)?.workUnit ?? undefined : undefined;
      if (anchorType !== "none") {
        // ADR-0089 v33: identity_key IS the work-unit anchor now. Reuse the same structured
        // key so supersede sees all siblings on the same PR.
        const workRef =
          opts.prRepo && opts.prNumber ? `${opts.prRepo}#${opts.prNumber}` :
          opts.gusWork ? opts.gusWork : null;
        const wuId = workRef ? `${opts.cluster}:${opts.role?.replace(/^\//, "")}:${workRef}` : null;
        if (wuId) {
          // ADR-0073: a fresh worker becomes THE embodiment of its identity; expire prior siblings.
          supersedeWorkUnitSiblings(db, wuId, id, now);
        }
      }
    } catch {
      /* store unwritable → best-effort */
    }
  }
}

/**
 * Expire the prior sessions of a work-unit when a fresh one takes it over (ADR-0073, spawn-side of
 * prefer-newest). Every non-retired session sharing `workUnitId` (except the new `keepId`) is
 * ARCHIVED — the "expired, not deleted" state: it drops out of live and is never revived, but stays
 * for lineage/history. A `meta.superseded_by` pointer records WHY (superseded by the new session,
 * not hand-archived), so the map/lineage can tell the two apart. Best-effort — never blocks a spawn.
 */
function supersedeWorkUnitSiblings(db: Database, workUnitId: string, keepId: string, now: string): void {
  try {
    for (const sid of sessionsForWorkUnit(db, workUnitId)) {
      if (sid === keepId) continue;
      const row = getRow(db, sid);
      if (!row) continue;
      const lc = lifecycleOf(row);
      if (lc === "completed" || lc === "archived") continue; // already retired — leave it
      setArchived(db, sid, true, now);
      setMeta(db, sid, "superseded_by", keepId, now);
    }
  } catch {
    /* best-effort — a supersede failure must never fail the spawn */
  }
}

/** Build the `claude` invocation for launch mode. Prompt (if any) is a trailing positional arg. */
function buildLaunchArgv(id: string, opts: NewSessionOpts): string[] {
  const argv = ["claude", "--session-id", id];
  if (opts.permissionMode) argv.push("--permission-mode", opts.permissionMode);
  if (opts.prompt) argv.push(opts.prompt);
  return argv;
}

/**
 * Validate a spawn is fully + correctly configured. Returns an error string (caller errors
 * out) or null. The determinism gate: a misconfigured spawn fails LOUD, never half-born.
 */
export function validateSpawn(opts: NewSessionOpts, roleDef: RoleDef | null): string | null {
  // A --role must name a real registry role (else its home_dir/arming can't be resolved).
  if (opts.role && !roleDef && !opts.identity) {
    return `role "${opts.role.replace(/^\//, "")}" is not in the registry — define it with \`ccs roles upsert\` first`;
  }
  // Standalone roles (registered outside a cluster) are not yet supported — they would create
  // sessions with NULL identity_key, violating system invariants (ADR-0089 step 33). Either
  // move the role under a cluster, or use `--cluster <name> --role <role>` explicitly.
  if (opts.role && roleDef && !opts.cluster && !roleDef.cluster) {
    return `standalone role "${opts.role.replace(/^\//, "")}" is not supported yet — register it under a cluster instead`;
  }
  // The cwd we'll launch in must exist (explicit --cwd or the role's home_dir).
  if (opts.cwd && !existsSync(opts.cwd)) {
    return `cwd does not exist: ${opts.cwd}`;
  }
  // A loop role must know how to come back running.
  if (roleDef?.kind === "loop" && !opts.resumeCommand) {
    return `loop role "${roleDef.role}" has no resume_command (it would launch dormant) — set one in the registry`;
  }
  return null;
}

export function newSession(args: string[]): number {
  const opts = parseOpts(args);
  const intentError = resolveLaunchIntent(opts);
  if (intentError) {
    console.error(`ccs new-session: ${intentError}`);
    return 2;
  }
  const explicitFlagsError = validateExplicitIdentityFlags(opts);
  if (explicitFlagsError) {
    console.error(`ccs new-session: ${explicitFlagsError}`);
    return 2;
  }

  ensureDataDir();
  // Registry defaults (ADR-0022): if --role names a defined role, inherit its home_dir as
  // the cwd and its resume_command — so bringing up a core role is just `--role <name>`.
  // Explicit --cwd / --resume-command still win.
  // Role definitions come from config FILES now (ADR-0050) — no catalogue read for the registry.
  // Resolve the role's definition. opts.cluster may not be set yet if the caller passes only
  // --role (cluster gets defaulted from the role def below); pass `undefined` here so the
  // legacy first-match scan resolves it, then re-anchor with an explicit cluster below when
  // available. ADR-D3.
  let roleDef: RoleDef | null = opts.role ? resolveRole(opts.role.replace(/^\//, ""), opts.cluster ?? undefined) : null;
  let spawnLocationErr: string | null = null;
  if (roleDef) {
    if (!opts.cluster && roleDef.cluster) opts.cluster = roleDef.cluster; // cluster from the definition
    // spawn-location config (ADR-0046) resolves the launch cwd from the LAUNCH REQUEST
    // (pre-row): "role-dir" → home_dir, "worktree" → the passed --cwd, or an abs path.
    // Config wins; the role's home_dir stays the fallback when no config resolves.
    if (!opts.cwd) {
      const resolvedCwd = resolveSpawnLocationCwd(opts, roleDef);
      if (resolvedCwd.error) { spawnLocationErr = resolvedCwd.error; }
      opts.cwd = resolvedCwd.cwd ?? roleDef.homeDir ?? undefined;
    }
    if (!opts.resumeCommand && roleDef.resumeCommand) opts.resumeCommand = roleDef.resumeCommand;
    // A loop role born fresh should START RUNNING: default the launch prompt to its
    // resume_command (the /loop …) unless an explicit --prompt was given.
    if (!opts.prompt && opts.resumeCommand) opts.prompt = opts.resumeCommand;
    // Loops run unattended → default to acceptEdits so they don't stall on edit prompts
    // (the folder-trust gate is handled separately via ~/.claude.json pre-trust).
    if (!opts.permissionMode && roleDef.kind === "loop") opts.permissionMode = "acceptEdits";
  }

  // A spawn-location config that named a mode whose input is missing (e.g. "worktree" with no
  // --cwd) is a determinism failure — fail LOUD, don't silently fall back to the wrong dir.
  if (spawnLocationErr) {
    console.error(`ccs new-session: ${spawnLocationErr}`);
    return 2;
  }

  // DETERMINISM: validate the spawn is fully set up, or ERROR OUT — never produce a
  // half-configured / mis-bound session (ADR-0042). Skipped for --print-id (a bare reserve
  // is allowed) only where a check can't apply.
  const err = validateSpawn(opts, roleDef);
  if (err) {
    console.error(`ccs new-session: ${err}`);
    return 2;
  }

  // WORKER SPAWN CONTRACT (ADR-0047): a worker (one carrying PR/work-unit facts) is born correct
  // or not at all — refuse a second embodiment of a live work-unit, or a cwd that isn't the PR's
  // feature-branch worktree. The liveness/git probes are best-effort: a probe FAILURE never
  // blocks a spawn (that would be worse than the check) — only a probe that positively finds a
  // conflict does. Core roles carry no work-unit and pass through untouched.
  const contractErr = checkSpawnContract(opts);
  if (contractErr) {
    console.error(`ccs new-session: ${contractErr}`);
    return 2;
  }

  // ADR-D2 (bug B11, 2026-07-14): the inter-layer version gate now runs on every bring-online
  // path, not just `ccs resume-cluster`. new-session used to spawn a worker into a cluster
  // whose requires_ccs declared a MAJOR shortfall (config expected v2, tool at v0) — the sensor
  // and catalogue-sync would then quietly disagree in unpredictable ways. Now the spawn refuses
  // loudly. Only runs when a cluster is known (a standalone spawn has no gate to run).
  if (opts.cluster) {
    const gate = checkClusterGate(opts.cluster, pkg.version);
    if (gate.status === "refuse") {
      console.error(`ccs new-session: ${gate.message}. Nothing spawned.`);
      return 2;
    }
    if (gate.status === "warn") {
      console.error(`ccs new-session: ${gate.message}`);
    }
  }

  const cwd = opts.cwd ?? process.cwd();

  // Explicit identity births must reject before an id is minted or a catalogue row is created.
  // Keep this connection through registration so validation and the atomic metadata write observe
  // the same catalogue state.
  const db = openCatalogue(CATALOGUE_PATH());
  let id: string;
  try {
    const explicitIdentityError = validateExplicitIdentityBirth(db, opts);
    if (explicitIdentityError) {
      console.error(`ccs new-session: ${explicitIdentityError}`);
      return 2;
    }
    id = randomUUID();
    writeSessionMetadata(db, id, opts, new Date().toISOString());
    // ADR-0075: run the role's declared BIRTH setup (grant-perms, seed-files, …) in the launch
    // cwd, now that the row exists (rowResolved). Runs for BOTH --print-id (reserve) and direct
    // launch, so setup is done before the launcher (spawn-agent / this process) starts claude.
    const row = getRow(db, id);
    if (row) {
      const spawnRes = runSpawnActions({ row, cwd });
      for (const err of spawnRes.errors) console.error(`ccs new-session: spawn setup — ${err}`);
    }
  } finally {
    db.close();
  }

  // Reserve mode: hand the id back so an external launcher owns the spawn. ONLY the bare id
  // goes to stdout (so `ID=$(ccs new-session … --print-id)` works); notes go to stderr.
  if (opts.printId) {
    const tagged = [
      opts.cluster && `cluster=${opts.cluster}`,
      opts.role && `role=${opts.role}`,
    ]
      .filter(Boolean)
      .join(" ");
    console.error(`ccs: reserved ${id.slice(0, 8)}…${tagged ? ` (${tagged})` : ""} — launch with: claude --session-id ${id}`);
    console.log(id);
    return 0;
  }

  const argv = buildLaunchArgv(id, opts);

  // --inline: genuine interactive launch in THIS terminal. Binds to the caller's surface —
  // correct only when that IS the intent. NOT the default (ADR-0042).
  if (opts.inline) {
    console.error(`ccs: launching INLINE ${argv.map(shellQuote).join(" ")}  (cwd: ${cwd})`);
    try {
      const result = Bun.spawnSync(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      const outcome = inlineLaunchOutcome(result.exitCode, result.signalCode);
      if (outcome.startupFailed) {
        console.error("ccs: could not run claude — is it on your PATH?");
        reportRecoverableExplicitBirth(id, opts.identity);
      }
      return outcome.exitCode;
    } catch (e) {
      console.error(`ccs: failed to launch claude: ${(e as Error).message}`);
      reportRecoverableExplicitBirth(id, opts.identity);
      return 127;
    }
  }

  // DEFAULT: spawn DETACHED into a fresh cmux workspace. The new surface gets its OWN
  // CMUX_SURFACE_ID, so the new session's SessionStart hook binds THAT surface — never
  // rebinding the caller's (the hijack ADR-0042 documents). Deterministic: own surface or fail.
  return spawnDetached(id, argv, cwd, opts.title || opts.role || id.slice(0, 8), opts.identity);
}

export function inlineLaunchOutcome(
  exitCode: number | null,
  signalCode: string | undefined,
): { exitCode: number; startupFailed: boolean } {
  // A numeric exit code or signal proves the child process started. Only absent exit and signal
  // codes identify a startup failure that leaves the registered session unlaunched.
  if (exitCode !== null) return { exitCode, startupFailed: false };
  if (signalCode !== undefined) {
    const signalNumber = Object.entries(constants.signals).find(([name]) => name === signalCode)?.[1];
    return { exitCode: signalNumber === undefined ? 1 : 128 + signalNumber, startupFailed: false };
  }
  return { exitCode: 127, startupFailed: true };
}

function reportRecoverableExplicitBirth(id: string, identity: string | undefined): void {
  if (!identity) return;
  console.error(
    `ccs: launch failed after registration; session ${id} remains attached to identity '${identity}' and can be retried with claude --session-id ${id}`,
  );
}

/**
 * Resolve the launch cwd from the role's spawn-location config (ADR-0046), pre-row. Builds a
 * synthetic row from the launch opts, resolves `spawn-location` (most-specific-wins) through the
 * shared config resolver, and interprets it. Returns {cwd} (null → caller uses home_dir default)
 * or {error} when config names a mode whose input is missing. Best-effort: a resolver failure
 * yields null (fall back), never a throw.
 */
function resolveSpawnLocationCwd(
  opts: NewSessionOpts,
  roleDef: RoleDef,
): { cwd: string | null; error?: string } {
  try {
    const row = syntheticRow({
      cluster: opts.cluster, role: opts.role?.replace(/^\//, ""), gusWork: opts.gusWork,
      prNumber: opts.prNumber, prRepo: opts.prRepo,
    });
    const config = resolveConfig(row, "spawn-location", liveResolveCtx()).effective as SpawnLocationConfig | null;
    return interpretSpawnLocation(config, { homeDir: roleDef.homeDir, requestedCwd: opts.cwd ?? null });
  } catch {
    return { cwd: null }; // resolver hiccup → fall back to home_dir default
  }
}

/**
 * Gather the impure spawn facts (the cwd's git branch) and run the pure contract (ADR-0047).
 * Best-effort probe: a probe that THROWS returns "unknown" and never blocks the spawn — only a
 * positively-observed born-WRONG configuration (a protected-branch worktree) is a hard error.
 *
 * NOTE (ADR-0073): this no longer gathers live work-units or refuses a second embodiment. A
 * duplicate embodiment is tolerated (resume prefers the MRU session and warns; atomic drain keeps
 * it harmless), so the contract only guards worktree correctness now. Returns an error or null.
 */
function checkSpawnContract(opts: NewSessionOpts): string | null {
  const facts: SpawnFacts = { gusWork: opts.gusWork, prNumber: opts.prNumber, prRepo: opts.prRepo, cwd: opts.cwd };

  // Worktree state: only probed when a cwd + PR are given (a worker). A git failure → unknown.
  let worktree: WorktreeState | null = null;
  if (opts.cwd && opts.prNumber != null) {
    worktree = probeWorktree(opts.cwd);
  }

  return spawnContractError(facts, worktree);
}

/** Probe a cwd's git worktree state (best-effort). Never throws. */
function probeWorktree(cwd: string): WorktreeState {
  try {
    const inside = execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    if (inside !== "true") return { isGitWorktree: false, branch: null };
    let branch: string | null = null;
    try {
      branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim() || null;
      if (branch === "HEAD") branch = null; // detached
    } catch { /* branch unknown */ }
    return { isGitWorktree: true, branch };
  } catch {
    // `git` failed entirely (not a repo, git missing) — treat as "not a worktree" ONLY if the
    // path exists; if git itself is unavailable we can't assert, so report unknown (git present
    // check via a benign call). Simplest safe default: not-a-worktree so the check can catch a
    // genuinely-wrong cwd, but a git-missing environment would false-positive — mitigated by the
    // caller only invoking this when cwd+PR are set (a real worker context has git).
    return { isGitWorktree: false, branch: null };
  }
}

/**
 * Spawn a session into a NEW cmux workspace (its own surface) via the shared spawnCmux primitive —
 * the SAME detached-spawn + CMUX_SURFACE_ID env-scrub (ADR-0042) used by resume, so a born-fresh
 * and a resumed session launch identically.
 */
function spawnDetached(id: string, argv: string[], cwd: string, name: string, identity: string | undefined): number {
  const ref = spawnCmux({ argv, cwd, name });
  if (ref === null) {
    console.error(`ccs: failed to spawn cmux workspace for ${id.slice(0, 8)} (cwd ${cwd})`);
    reportRecoverableExplicitBirth(id, identity);
    return 1;
  }
  console.error(`ccs: spawned ${name} → ${ref} (session ${id.slice(0, 8)}, cwd ${cwd})`);
  return 0;
}
