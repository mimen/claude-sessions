import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Database } from "bun:sqlite";
import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";
import {
  openCatalogue,
  setCustomTitle,
  setKey,
  setParent,
  setSessionClass,
  setCreatorKind,
  setCreatorRef,
  setLaunchChannel,
  setForkedFromSessionId,
  setLauncherIdentity,
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
  type CreatorKind,
  type LaunchChannel,
  type RoleDef,
} from "../catalogue/db.ts";
import pkg from "../../package.json" with { type: "json" };
import { resolveWorkUnit } from "../catalogue/resolve-work-unit.ts";
import { getIdentity } from "../catalogue/identities.ts";
import { resolveRole } from "../roles/role-files.ts";
import {
  checkClusterGate,
  clusterManifestExists,
  readClusterManifest,
  type ClusterManifest,
} from "../cluster/manifest.ts";
import {
  isPermissionMode,
  permissionModeValidationError,
  resolvePermissionMode,
} from "../roles/permission-mode.ts";
import { shellQuote } from "./command.ts";
import { spawnCmux } from "./spawn-cmux.ts";
import { launcherEnvironment, type Launcher } from "./launchers.ts";
import type { BirthModelId } from "./role-model-launch.ts";
import {
  compileExactBirthRoute,
  resolveBirthRoute,
  type ExactBirthRoute,
} from "./birth-route.ts";
import { execFileSync } from "node:child_process";
import { spawnContractError, type SpawnFacts, type WorktreeState } from "../catalogue/spawn-contract.ts";
import { interpretSpawnLocation, syntheticRow, type SpawnLocationConfig } from "../catalogue/spawn-location.ts";
import { resolveConfig } from "../hooks/resolve-config.ts";
import { liveResolveCtx } from "../hooks/compose-claude-md.ts";
import { runSpawnActions } from "../hooks/spawn-actions.ts";
import { resolveNewSessionCreator } from "../session-provenance.ts";
import { loadConfig, type Config } from "../config.ts";
import {
  activeHostByCanonicalName,
  loadHostRegistry,
  validateHostCapabilities,
} from "../hosts/registry.ts";
import {
  effectiveLocationDefaults,
  loadLocationRegistry,
  locationByKey,
  resolveLocationForHost,
  validateLocationHostEligibility,
  type LaunchLocation,
} from "../locations/registry.ts";
import { type Result, err as resultErr, ok as resultOk } from "../result.ts";
import {
  launchRemoteSession,
  preflightRemoteSession,
  type RemoteLaunchOutcome,
  type RemotePreflight,
  type RemotePreflightRequest,
  type RemoteSessionRequest,
} from "./remote-session.ts";

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
   * not a per-session flag. Populated internally from roleDef; used only for the launch prompt,
   * never stored (kind/resume_command columns dropped v29). */
  resumeCommand?: string;
  project?: string;
  key?: string;
  title?: string;
  parent?: string;
  /** Required birth declaration: independent work body versus causal auxiliary child. */
  topLevel?: boolean;
  childOf?: string;
  /** Internal birth provenance. Derived from managed launch context, never CLI flags. */
  creatorKind?: CreatorKind;
  creatorRef?: string;
  launchChannel?: LaunchChannel;
  forkedFromSessionId?: string;
  launcherIdentity?: string;
  /** Work-item id (W-number) — stamped at birth so the statusline/tab link the ticket from
   * turn one (ADR-0027), before any later git/PR sense tick. */
  gusWork?: string;
  /** PR facts known at spawn (the fleet already has repo + number in hand). Stamped at birth
   * so the clickable PR link is present immediately — no gap until the next sense tick. */
  prNumber?: number;
  prRepo?: string;
  cwd?: string;
  /** Curated launch-location key. Resolved before any session id or catalogue row is created. */
  location?: string;
  /** Canonical placement host. Omitted or current host preserves the local launch path. */
  host?: string;
  /** Resolved location identity retained for birth metadata. */
  locationKey?: string;
  /** Effective registry/location harness default, retained for pre-birth route compilation. */
  locationDefaultHarness?: string;
  /** Effective registry/location model default, retained as launch-location provenance. */
  locationDefaultModel?: string;
  prompt?: string;
  /** Passed through to `claude --permission-mode <mode>` when launching. */
  permissionMode?: string;
  /** Reserve mode: write metadata + print the id, don't launch. */
  printId: boolean;
  /** Escape hatch: launch INLINE in the current terminal (Bun.spawnSync, inherits this
   * surface). Default is DETACHED into a fresh cmux workspace — inline hijacks the caller's
   * CMUX_SURFACE_ID and rebinds their tab to the new session (ADR-0042). */
  inline: boolean;
  /** Launch through a configured launcher when no exact model policy is supplied. */
  via?: string;
  /** Explicit canonical model request for a policy-less top-level birth. */
  model?: string;
  /** Host capabilities inferred by the conversational router and revalidated by CCS. */
  requiredCapabilities?: readonly string[];
  /** Emit a structured local launch receipt. Remote launches always emit their pending receipt. */
  json?: boolean;
  /** Derived launch provenance for a model-policy role, explicit model, or location default. */
  launchCanonicalModel?: BirthModelId;
  launchModel?: string;
  launchLauncher?: string;
}

/** Parse a --pr-number value to a positive integer, or undefined (0 / non-numeric = "no PR yet"). */
function prNumberFrom(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const VALUE_FLAGS = new Set([
  "--cluster", "--identity", "--role", "--skill", "--project", "--key", "--title", "--parent", "--child-of",
  "--gus-work", "--pr-number", "--pr-repo", "--cwd", "--location", "--host", "--prompt", "--permission-mode", "--via", "--model", "--require-capability",
]);
const BOOLEAN_FLAGS = new Set(["--print-id", "--top-level", "--inline", "--json"]);

interface ParsedOptions {
  values: Map<string, string>;
  allValues: Map<string, string[]>;
  booleans: Set<string>;
}

/** Parse known options in order so text supplied to another flag is never reinterpreted as a flag. */
function parseOptions(args: string[]): Result<ParsedOptions> {
  const values = new Map<string, string>();
  const allValues = new Map<string, string[]>();
  const booleans = new Set<string>();
  const record = (flag: string, value: string): void => {
    values.set(flag, value);
    allValues.set(flag, [...(allValues.get(flag) ?? []), value]);
  };
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    if (VALUE_FLAGS.has(flag)) {
      if (equals !== -1) {
        const value = token.slice(equals + 1);
        if (!value) return resultErr(new Error(`${flag} requires a value`));
        record(flag, value);
        continue;
      }
      const value = args[index + 1];
      if (value === undefined || (flag !== "--prompt" && value.startsWith("--"))) {
        return resultErr(new Error(`${flag} requires a value`));
      }
      // Prompts are free-form and may intentionally begin with `--`; all other option values use
      // the conventional non-flag token form so a missing value cannot swallow the next option.
      record(flag, value);
      index++;
      continue;
    }
    if (BOOLEAN_FLAGS.has(token)) booleans.add(token);
  }
  return resultOk({ values, allValues, booleans });
}

function normalizedRole(role: string): string {
  return role.replace(/^\//, "");
}

export function parseOpts(args: string[]): Result<NewSessionOpts> {
  const parsed = parseOptions(args);
  if (!parsed.ok) return parsed;
  const { values, allValues, booleans } = parsed.value;
  const permissionMode = values.get("--permission-mode");
  if (permissionMode !== undefined && !isPermissionMode(permissionMode)) {
    return resultErr(new Error(`--permission-mode: ${permissionModeValidationError()}`));
  }
  return resultOk({
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
    location: values.get("--location"),
    host: values.get("--host"),
    prompt: values.get("--prompt"),
    permissionMode,
    printId: booleans.has("--print-id"),
    topLevel: booleans.has("--top-level"),
    inline: booleans.has("--inline"),
    via: values.get("--via"),
    model: values.get("--model"),
    requiredCapabilities: allValues.get("--require-capability") ?? [],
    json: booleans.has("--json"),
  });
}

/** Apply one registered launch location before any birth reservation occurs. */
export function applyLocationDefaults(opts: NewSessionOpts, loadedConfig?: Config): Result<LaunchLocation | null> {
  if (!opts.location) return resultOk(null);
  if (opts.cwd) return resultErr(new Error("--location cannot be combined with --cwd"));
  const config = loadedConfig ? resultOk(loadedConfig) : loadConfig();
  if (!config.ok) return resultErr(config.error);
  const registryPath = config.value.routing.registry;
  if (!registryPath) return resultErr(new Error("--location requires [routing].registry in ~/.ccs/config.toml"));
  const registry = loadLocationRegistry(registryPath);
  if (!registry.ok) return resultErr(registry.error);
  const location = locationByKey(registry.value, opts.location);
  if (!location) return resultErr(new Error(`unknown launch location "${opts.location}"`));
  const resolved = resolveLocationForHost(location, config.value.host.label);
  if (!resolved.ok) return resultErr(resolved.error);
  const defaults = effectiveLocationDefaults(registry.value, location);
  opts.cwd = resolved.value.cwd;
  opts.locationKey = resolved.value.key;
  opts.locationDefaultHarness = defaults.defaultHarness ?? undefined;
  opts.locationDefaultModel = defaults.defaultModel ?? undefined;
  if (!opts.title) opts.title = resolved.value.name;
  return resultOk(resolved.value);
}

export interface NewSessionPreflightReceipt {
  readonly status: "ready";
  readonly host: string;
  readonly location: {
    readonly key: string;
    readonly name: string;
    readonly cwd: string;
  };
  readonly route: ExactBirthRoute;
  readonly required_capabilities: readonly string[];
}

/** Validate one loose top-level birth on this machine without reserving a session or creating a workspace. */
export function preflightNewSession(args: string[]): number {
  const parsed = parseOpts(args);
  if (!parsed.ok) {
    console.error(`ccs session preflight: ${parsed.error.message}`);
    return 2;
  }
  const opts = parsed.value;
  if (!opts.topLevel || opts.childOf) {
    console.error("ccs session preflight: require --top-level without --child-of");
    return 2;
  }
  if (!opts.location) {
    console.error("ccs session preflight: require --location");
    return 2;
  }
  if (opts.cwd || opts.inline || opts.printId || opts.identity || opts.cluster || opts.role || opts.project || opts.key) {
    console.error("ccs session preflight: only loose top-level location births are supported");
    return 2;
  }

  const config = loadConfig();
  if (!config.ok) {
    console.error(`ccs session preflight: ${config.error.message}`);
    return 2;
  }
  if (opts.host && !sameCanonicalHost(opts.host, config.value.host.label)) {
    console.error(
      `ccs session preflight: reached host "${config.value.host.label}", expected "${opts.host}"`,
    );
    return 2;
  }

  const location = applyLocationDefaults(opts, config.value);
  if (!location.ok) {
    console.error(`ccs session preflight: ${location.error.message}`);
    return 2;
  }
  if (!location.value) {
    console.error("ccs session preflight: require --location");
    return 2;
  }

  const hosts = loadHostRegistry(config.value.routing.hosts);
  if (!hosts.ok) {
    console.error(`ccs session preflight: ${hosts.error.message}`);
    return 2;
  }
  const host = activeHostByCanonicalName(hosts.value, config.value.host.label);
  if (!host) {
    console.error(`ccs session preflight: current host "${config.value.host.label}" is not active in the host registry`);
    return 2;
  }
  const capabilities = validateHostCapabilities(host, opts.requiredCapabilities ?? []);
  if (!capabilities.ok) {
    console.error(`ccs session preflight: ${capabilities.error.message}`);
    return 2;
  }

  const route = resolveBirthRoute({
    model: opts.model,
    via: opts.via,
    locationKey: location.value.key,
    defaultHarness: opts.locationDefaultHarness,
    defaultModel: opts.locationDefaultModel,
  });
  if (!route.ok) {
    console.error(`ccs session preflight: ${route.error.message}`);
    return 2;
  }

  const receipt: NewSessionPreflightReceipt = {
    status: "ready",
    host: host.name,
    location: {
      key: location.value.key,
      name: location.value.name,
      cwd: location.value.cwd,
    },
    route: route.value.exact,
    required_capabilities: opts.requiredCapabilities ?? [],
  };
  console.log(JSON.stringify(receipt));
  return 0;
}

export interface RoutedRemoteSessionRequest extends RemoteSessionRequest {
  readonly model?: BirthModelId;
  readonly requiredCapabilities?: readonly string[];
}

export interface RemoteSessionDependencies {
  readonly preflight: (request: RemotePreflightRequest) => Result<RemotePreflight>;
  readonly launch: (request: RoutedRemoteSessionRequest) => RemoteLaunchOutcome;
}

const DEFAULT_REMOTE_SESSION_DEPENDENCIES: RemoteSessionDependencies = {
  preflight: preflightRemoteSession,
  launch: launchRemoteSession,
};

function sameCanonicalHost(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function recordExactLaunch(opts: NewSessionOpts, route: ExactBirthRoute): void {
  if (!route.model || !route.launchModel) return;
  opts.launchCanonicalModel = route.model;
  opts.launchModel = route.launchModel;
  opts.launchLauncher = route.launcher;
}

function unsupportedRemoteBirthOption(opts: NewSessionOpts): string | null {
  if (opts.inline) return "remote --host placement owns target-side --inline; do not pass --inline locally";
  if (opts.printId) return "remote --host placement does not support --print-id until the session-ID receipt seam lands";
  if (opts.cwd) return "remote --host placement requires --location and cannot use a source-side --cwd";
  if (opts.identity || opts.cluster || opts.role || opts.project || opts.key || opts.gusWork || opts.prNumber || opts.prRepo) {
    return "remote --host placement currently supports loose top-level location births only";
  }
  return null;
}

/** Place one top-level managed body on a registered remote host without reserving anything locally. */
export function launchRemoteNewSession(
  opts: NewSessionOpts,
  config: Config,
  dependencies: RemoteSessionDependencies = DEFAULT_REMOTE_SESSION_DEPENDENCIES,
): number {
  const targetHost = opts.host?.trim();
  if (!targetHost) {
    console.error("ccs new-session: --host requires a canonical host name");
    return 2;
  }
  if (!opts.location) {
    console.error("ccs new-session: remote --host placement requires --location");
    return 2;
  }
  const intentError = resolveLaunchIntent(opts);
  if (intentError) {
    console.error(`ccs new-session: ${intentError}`);
    return 2;
  }
  if (!opts.topLevel) {
    console.error("ccs new-session: remote --host placement currently supports --top-level only");
    return 2;
  }
  const optionError = unsupportedRemoteBirthOption(opts);
  if (optionError) {
    console.error(`ccs new-session: ${optionError}`);
    return 2;
  }

  const hosts = loadHostRegistry(config.routing.hosts);
  if (!hosts.ok) {
    console.error(`ccs new-session: ${hosts.error.message}`);
    return 2;
  }
  const host = activeHostByCanonicalName(hosts.value, targetHost);
  if (!host) {
    console.error(`ccs new-session: unknown or inactive remote host "${targetHost}"`);
    return 2;
  }
  const capabilities = validateHostCapabilities(host, opts.requiredCapabilities ?? []);
  if (!capabilities.ok) {
    console.error(`ccs new-session: ${capabilities.error.message}`);
    return 2;
  }

  const locations = loadLocationRegistry(config.routing.registry);
  if (!locations.ok) {
    console.error(`ccs new-session: ${locations.error.message}`);
    return 2;
  }
  const location = locationByKey(locations.value, opts.location);
  if (!location) {
    console.error(`ccs new-session: unknown launch location "${opts.location}"`);
    return 2;
  }
  const eligible = validateLocationHostEligibility(location, host.name);
  if (!eligible.ok) {
    console.error(`ccs new-session: ${eligible.error.message}`);
    return 2;
  }
  const defaults = effectiveLocationDefaults(locations.value, location);
  const exactRoute = compileExactBirthRoute({
    model: opts.model,
    via: opts.via,
    locationKey: location.key,
    defaultHarness: defaults.defaultHarness,
    defaultModel: defaults.defaultModel,
  });
  if (!exactRoute.ok) {
    console.error(`ccs new-session: ${exactRoute.error.message}`);
    return 2;
  }
  recordExactLaunch(opts, exactRoute.value);

  const creator = resolveNewSessionCreator(process.env);
  if (!creator.ok) {
    console.error(`ccs new-session: ${creator.error.message}`);
    return 2;
  }
  const preflight = dependencies.preflight({
    targetHost: host.name,
    sshAlias: host.sshAlias,
    locationKey: location.key,
    route: exactRoute.value,
    via: opts.via,
    model: exactRoute.value.model,
    requiredCapabilities: opts.requiredCapabilities ?? [],
  });
  if (!preflight.ok) {
    console.error(`ccs new-session: ${preflight.error.message}`);
    return 2;
  }

  const outcome = dependencies.launch({
    targetHost: host.name,
    sshAlias: host.sshAlias,
    locationKey: location.key,
    title: opts.title ?? preflight.value.locationName,
    prompt: opts.prompt,
    permissionMode: opts.permissionMode,
    via: opts.via,
    model: exactRoute.value.model ?? undefined,
    requiredCapabilities: opts.requiredCapabilities ?? [],
    creatorKind: creator.value.kind,
    creatorRef: creator.value.ref,
    remoteCwd: preflight.value.cwd,
  });
  console.log(JSON.stringify(outcome.receipt, null, 2));
  if (!outcome.ok) {
    console.error(`ccs new-session: ${outcome.error.message}`);
    return 2;
  }
  return 0;
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
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(parent)) return "--child-of must be a UUID or .";
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
  if (opts.locationKey) setMeta(db, id, "launch_location", opts.locationKey, now);
  if (opts.locationDefaultModel) setMeta(db, id, "launch_location_model", opts.locationDefaultModel, now);
  if (opts.parent) setParent(db, id, opts.parent, now);
  setSessionClass(db, id, opts.topLevel ? "work_body" : opts.parent ? "auxiliary" : null, now);
  if (opts.creatorKind) setCreatorKind(db, id, opts.creatorKind, now);
  if (opts.creatorRef) setCreatorRef(db, id, opts.creatorRef, now);
  if (opts.launchChannel) setLaunchChannel(db, id, opts.launchChannel, now);
  // Resolved birth route is audit-only metadata. Resume always routes from transcript history.
  if (opts.launchCanonicalModel) setMeta(db, id, "launch_model_id", opts.launchCanonicalModel, now);
  if (opts.launchModel) setMeta(db, id, "launch_model", opts.launchModel, now);
  if (opts.launchLauncher) setMeta(db, id, "launch_launcher", opts.launchLauncher, now);
  if (opts.forkedFromSessionId) setForkedFromSessionId(db, id, opts.forkedFromSessionId, now);
  setLauncherIdentity(db, id, opts.launcherIdentity ?? null, now);
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

/** Birth precedence adds the historical unattended-loop default beneath declared policy. */
export function resolveNewSessionPermissionMode(
  explicitMode: string | null | undefined,
  roleDef: Pick<RoleDef, "kind" | "permissionMode" | "manifestError"> | null,
  clusterManifest: Pick<ClusterManifest, "permissionMode"> | null,
): string | null {
  return explicitMode
    ?? resolvePermissionMode(roleDef, clusterManifest)
    ?? (roleDef?.kind === "loop" ? "acceptEdits" : null);
}

/** Build the launch invocation. Prompt (if any) is a trailing positional arg. `binary` comes
 * from the `--via` launcher; default is plain `claude`. */
export function buildLaunchArgv(id: string, opts: NewSessionOpts, binary = "claude"): string[] {
  const argv = [binary];
  // Model is a birth-only option and deliberately precedes --session-id in both transports.
  if (opts.launchModel) argv.push("--model", opts.launchModel);
  argv.push("--session-id", id);
  if (opts.permissionMode) argv.push("--permission-mode", opts.permissionMode);
  if (opts.prompt) argv.push(opts.prompt);
  return argv;
}

/** Launcher overrides that force the stable shim and carry one-birth provenance to it. */
export function launchEnvironmentOverrides(
  opts: NewSessionOpts,
  launcherEnv: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { ...launcherEnv };
  const shimDirectory = join(process.env.HOME ?? homedir(), ".ccs", "bin");
  const pathEntries = (environment.PATH ?? process.env.PATH ?? "").split(delimiter).filter(
    (entry) => entry.length > 0 && entry !== shimDirectory,
  );
  environment.PATH = [shimDirectory, ...pathEntries].join(delimiter);
  // A detached cmux shell may inherit these from its parent outside the explicit env prefix.
  // Empty values are treated as absent and cannot attribute descendants to the prior birth.
  environment.CCS_CREATOR_KIND = "";
  environment.CCS_CREATOR_REF = "";
  if (opts.creatorKind) environment.CCS_LAUNCH_CREATOR_KIND = opts.creatorKind;
  if (opts.creatorRef) environment.CCS_LAUNCH_CREATOR_REF = opts.creatorRef;
  if (opts.parent) environment.CCS_LAUNCH_PARENT_SESSION_ID = opts.parent;
  return environment;
}

/**
 * Exact inline environment: preserve ordinary variables but remove all inherited birth claims.
 *
 * `unset` is the launcher's `clears`, applied to the INHERITED environment before its assignments.
 * An inline birth builds its environment from `process.env`, so without this a `--via
 * claude-native` birth from inside a gateway session would carry that session's ANTHROPIC_BASE_URL
 * straight into the "escape hatch" harness.
 */
export function inlineLaunchEnvironment(
  opts: NewSessionOpts,
  launcherEnv: Readonly<Record<string, string>>,
  unset: readonly string[] = [],
): Readonly<Record<string, string>> {
  const cleared = new Set(unset);
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "CCS_CREATOR_KIND" || key === "CCS_CREATOR_REF") continue;
    if (key === "CCS_LAUNCH_CREATOR_KIND" || key === "CCS_LAUNCH_CREATOR_REF" || key === "CCS_LAUNCH_PARENT_SESSION_ID") continue;
    if (cleared.has(key)) continue;
    environment[key] = value;
  }
  Object.assign(environment, launchEnvironmentOverrides(opts, launcherEnv));
  delete environment.CCS_CREATOR_KIND;
  delete environment.CCS_CREATOR_REF;
  return environment;
}

/**
 * Validate a spawn is fully + correctly configured. Returns an error string (caller errors
 * out) or null. The determinism gate: a misconfigured spawn fails LOUD, never half-born.
 */
export function validateSpawn(opts: NewSessionOpts, roleDef: RoleDef | null): string | null {
  if (roleDef?.manifestError) return `role "${roleDef.role}" has invalid role.toml: ${roleDef.manifestError}`;
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

export interface NewSessionLaunchControls {
  /** Focus the fresh detached cmux workspace as part of creation. */
  readonly focus?: boolean;
  /** Observe the exact local detached-launch receipt without parsing console output. */
  readonly onLocalLaunch?: (receipt: LocalLaunchReceipt) => void;
}

export function newSession(
  args: string[],
  remoteDependencies: RemoteSessionDependencies = DEFAULT_REMOTE_SESSION_DEPENDENCIES,
  launchControls: NewSessionLaunchControls = {},
): number {
  const parsed = parseOpts(args);
  if (!parsed.ok) {
    console.error(`ccs new-session: ${parsed.error.message}`);
    return 2;
  }
  const opts = parsed.value;
  const config = loadConfig();
  if (!config.ok) {
    console.error(`ccs new-session: ${config.error.message}`);
    return 2;
  }
  if (opts.host !== undefined && !sameCanonicalHost(opts.host, config.value.host.label)) {
    return launchRemoteNewSession(opts, config.value, remoteDependencies);
  }
  const location = applyLocationDefaults(opts, config.value);
  if (!location.ok) {
    console.error(`ccs new-session: ${location.error.message}`);
    return 2;
  }
  let selectedHost = config.value.host.label;
  if ((opts.requiredCapabilities?.length ?? 0) > 0) {
    const hosts = loadHostRegistry(config.value.routing.hosts);
    if (!hosts.ok) {
      console.error(`ccs new-session: ${hosts.error.message}`);
      return 2;
    }
    const host = activeHostByCanonicalName(hosts.value, config.value.host.label);
    if (!host) {
      console.error(`ccs new-session: current host "${config.value.host.label}" is not active in the host registry`);
      return 2;
    }
    const capabilities = validateHostCapabilities(host, opts.requiredCapabilities ?? []);
    if (!capabilities.ok) {
      console.error(`ccs new-session: ${capabilities.error.message}`);
      return 2;
    }
    selectedHost = host.name;
  }
  const explicitRouteValidation = compileExactBirthRoute({
    model: opts.model,
    via: opts.via,
    locationKey: opts.locationKey ?? opts.location ?? "unregistered cwd",
  });
  if (!explicitRouteValidation.ok) {
    console.error(`ccs new-session: ${explicitRouteValidation.error.message}`);
    return 2;
  }
  const intentError = resolveLaunchIntent(opts);
  if (intentError) {
    console.error(`ccs new-session: ${intentError}`);
    return 2;
  }
  if (opts.json && opts.printId) {
    console.error("ccs new-session: --json cannot be combined with --print-id");
    return 2;
  }
  if (opts.json && opts.inline) {
    console.error("ccs new-session: --json is for detached local receipts; inline owns the terminal");
    return 2;
  }
  const creator = resolveNewSessionCreator(process.env, opts.parent);
  if (!creator.ok) {
    console.error(`ccs new-session: ${creator.error.message}`);
    return 2;
  }
  opts.creatorKind = creator.value.kind;
  opts.creatorRef = creator.value.ref ?? undefined;
  opts.launchChannel = "ccs_session_new";
  opts.launcherIdentity = process.env.CLAUDE_IDENTITY;
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
  }

  // ADR-0094: permission mode is embodiment policy, not transcript history. Resolve it for every
  // birth with the authored role above cluster, then retain the historical loop default only when
  // neither layer declares a posture. role.toml policy errors are blocked by validateSpawn below.
  let clusterManifest: ClusterManifest | null = null;
  if (opts.cluster) {
    const loadedManifest = readClusterManifest(opts.cluster);
    if (loadedManifest.ok) clusterManifest = loadedManifest.value;
    // A cluster that SHIPS a manifest it can't parse has declared a posture ccs cannot honor.
    // Proceeding would silently launch under the legacy default (or none) — the exact failure
    // ADR-0094 exists to kill. Refuse the birth; a fresh session is cheap to retry once the
    // manifest is fixed. A cluster with NO manifest at all is a different case (ad-hoc / legacy):
    // it keeps the pre-existing warn-and-proceed path via checkClusterGate below.
    else if (clusterManifestExists(opts.cluster)) {
      console.error(`ccs new-session: ${loadedManifest.error.message}. Nothing spawned.`);
      return 2;
    }
  }
  opts.permissionMode = resolveNewSessionPermissionMode(opts.permissionMode, roleDef, clusterManifest) ?? undefined;

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

  // Route precedence is explicit: role policy, explicit canonical model, caller launcher,
  // then the location/registry exact default. The same resolver powers target-side remote preflight.
  const resolvedRoute = resolveBirthRoute({
    roleModel: roleDef?.model,
    model: opts.model,
    via: opts.via,
    locationKey: opts.locationKey ?? opts.location ?? "unregistered cwd",
    defaultHarness: opts.locationDefaultHarness,
    defaultModel: opts.locationDefaultModel,
  });
  if (!resolvedRoute.ok) {
    console.error(`ccs new-session: ${resolvedRoute.error.message}`);
    return 2;
  }
  const launcher: Launcher = resolvedRoute.value.launcher;
  // Resolve the launcher's environment from the SAME compiled directives the shim's spec file is
  // rendered from, and fail before an id is minted: a birth that cannot install its launcher's
  // environment must not become a half-born catalogue row on the wrong backend.
  const launcherEnv = launcherEnvironment(launcher);
  if (!launcherEnv.ok) {
    console.error(`ccs new-session: launcher "${launcher.name}": ${launcherEnv.error.message}`);
    return 2;
  }
  recordExactLaunch(opts, resolvedRoute.value.exact);

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
    console.error(
      `ccs: reserved ${id.slice(0, 8)}…${tagged ? ` (${tagged})` : ""} — launch with: ` +
      buildLaunchArgv(id, opts, launcher.binary).map(shellQuote).join(" "),
    );
    console.log(id);
    return 0;
  }

  const argv = buildLaunchArgv(id, opts, launcher.binary);

  // --inline: genuine interactive launch in THIS terminal. Binds to the caller's surface —
  // correct only when that IS the intent. NOT the default (ADR-0042).
  if (opts.inline) {
    console.error(`ccs: launching INLINE ${argv.map(shellQuote).join(" ")}  (cwd: ${cwd})`);
    try {
      const result = Bun.spawnSync(argv, {
        cwd,
        env: { ...inlineLaunchEnvironment(opts, launcherEnv.value.assign, launcherEnv.value.unset) },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const outcome = inlineLaunchOutcome(result.exitCode, result.signalCode);
      if (outcome.startupFailed) {
        console.error(`ccs: could not run ${launcher.binary} — is it on your PATH?`);
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
  const title = opts.title || opts.role || id.slice(0, 8);
  const detached = spawnDetached(
    id,
    argv,
    cwd,
    title,
    opts.identity,
    launchEnvironmentOverrides(opts, launcherEnv.value.assign),
    launchControls.focus ?? false,
    launcherEnv.value.unset,
  );
  const receipt = buildLocalLaunchReceipt({
    id,
    title,
    host: selectedHost,
    location: opts.locationKey ?? null,
    cwd,
    harness: opts.launchLauncher ?? launcher.name,
    model: opts.launchCanonicalModel ?? null,
    launchModel: opts.launchModel ?? null,
    outcome: detached,
  });
  launchControls.onLocalLaunch?.(receipt);
  if (opts.json) console.log(JSON.stringify(receipt, null, 2));
  return detached.exitCode;
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

export interface LocalLaunchReceipt {
  readonly status: "launched" | "workspace_failed";
  readonly session_id: string;
  readonly title: string;
  readonly host: string;
  readonly location: string | null;
  readonly cwd: string;
  readonly harness: string;
  readonly model: BirthModelId | null;
  readonly launch_model: string | null;
  readonly workspace_ref: string | null;
  readonly error: string | null;
}

interface DetachedLaunchOutcome {
  readonly exitCode: number;
  readonly workspaceRef: string | null;
  readonly error: string | null;
}

export function buildLocalLaunchReceipt(input: {
  readonly id: string;
  readonly title: string;
  readonly host: string;
  readonly location: string | null;
  readonly cwd: string;
  readonly harness: string;
  readonly model: BirthModelId | null;
  readonly launchModel: string | null;
  readonly outcome: DetachedLaunchOutcome;
}): LocalLaunchReceipt {
  return {
    status: input.outcome.workspaceRef ? "launched" : "workspace_failed",
    session_id: input.id,
    title: input.title,
    host: input.host,
    location: input.location,
    cwd: input.cwd,
    harness: input.harness,
    model: input.model,
    launch_model: input.launchModel,
    workspace_ref: input.outcome.workspaceRef,
    error: input.outcome.error,
  };
}

/**
 * Spawn a session into a NEW cmux workspace (its own surface) via the shared spawnCmux primitive —
 * the SAME detached-spawn + CMUX_SURFACE_ID env-scrub (ADR-0042) used by resume, so a born-fresh
 * and a resumed session launch identically.
 */
function spawnDetached(
  id: string,
  argv: string[],
  cwd: string,
  name: string,
  identity: string | undefined,
  env: Readonly<Record<string, string>> = {},
  focus = false,
  unset: readonly string[] = [],
): DetachedLaunchOutcome {
  const ref = spawnCmux({ argv, cwd, name, env, unset, focus });
  if (ref === null) {
    const error = `failed to spawn cmux workspace for session ${id} (cwd ${cwd})`;
    console.error(`ccs: ${error}`);
    reportRecoverableExplicitBirth(id, identity);
    return { exitCode: 1, workspaceRef: null, error };
  }
  console.error(`ccs: spawned ${name} → ${ref} (session ${id}, cwd ${cwd})`);
  return { exitCode: 0, workspaceRef: ref, error: null };
}
