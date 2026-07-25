import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { CATALOGUE_PATH, DB_PATH } from "../paths.ts";
import { loadConfig, type Config } from "../config.ts";
import { activeHostByCanonicalName, loadHostRegistry, type HostRegistryEntry } from "../hosts/registry.ts";
import { compileLocationModelLaunch } from "../resume/role-model-launch.ts";
import { openIndex } from "../index/schema.ts";
import { listByRecency } from "../index/index.ts";
import {
  effectiveLocationDefaults,
  loadLocationRegistry,
  locationByKey,
  matchLocations,
  registerLocation,
  resolveLocationForHost,
  retireLocation,
  type LaunchLocation,
  type LocationKind,
  type LocationRegistry,
  type RegistrationPathPolicy,
} from "./registry.ts";

interface ParsedArgs {
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
  readonly positional: readonly string[];
}

export interface LocationCommandDependencies {
  readonly registrationPathPolicy?: RegistrationPathPolicy;
}

interface SessionWarning {
  readonly sessionId: string;
  readonly title: string;
  readonly lifecycle: string;
}

export interface GitContext {
  readonly root: string;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly linkedWorktree: boolean;
}

export interface CallerContext {
  readonly cwd: string;
  readonly git: GitContext | null;
}

interface RegisteredHostPayload {
  readonly name: string;
  readonly capabilities: readonly string[];
}

interface LocationPayload {
  readonly key: string;
  readonly host: string;
  readonly current_host: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly cwd: string;
  readonly kind: LocationKind;
  readonly eligible_hosts: readonly string[];
  readonly preferred_host: string;
  readonly host_capabilities: readonly string[];
  readonly declared_default_harness: string | null;
  readonly declared_default_model: string | null;
  readonly default_harness: string | null;
  readonly default_model: string | null;
  readonly status: string;
  readonly host_eligible: boolean;
  readonly validation_error: string | null;
  readonly git_state: GitContext | null;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      const flag = token.slice(2, equals);
      const value = token.slice(equals + 1);
      values.set(flag, [...(values.get(flag) ?? []), value]);
      continue;
    }
    const flag = token.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(flag, [...(values.get(flag) ?? []), next]);
      index++;
    } else {
      booleans.add(flag);
    }
  }
  return { values, booleans, positional };
}

function first(parsed: ParsedArgs, key: string): string | undefined {
  return parsed.values.get(key)?.[0];
}

function configOrError(): Config | null {
  const loaded = loadConfig();
  if (!loaded.ok) {
    console.error(`ccs location: ${loaded.error.message}`);
    return null;
  }
  if (!loaded.value.routing.registry) {
    console.error("ccs location: no registry configured; set [routing].registry in ~/.ccs/config.toml");
    return null;
  }
  return loaded.value;
}

function gitText(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function gitContextForPath(cwd: string): GitContext | null {
  const metadata = gitText(cwd, [
    "rev-parse",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (!metadata) return null;
  const [rootOutput, gitDirOutput, commonDirOutput, branchOutput] = metadata.split("\n");
  if (!rootOutput || !gitDirOutput || !commonDirOutput || !branchOutput) return null;
  try {
    const root = realpathSync(rootOutput);
    const gitDir = realpathSync(resolve(cwd, gitDirOutput));
    const commonDir = realpathSync(resolve(cwd, commonDirOutput));
    const status = gitText(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
    if (status === null) return null;
    return {
      root,
      branch: branchOutput === "HEAD" ? null : branchOutput,
      dirty: status.length > 0,
      gitDir,
      commonDir,
      linkedWorktree: gitDir !== commonDir,
    };
  } catch {
    return null;
  }
}

function callerContext(): CallerContext {
  const cwd = existsSync(process.cwd()) ? realpathSync(process.cwd()) : process.cwd();
  return { cwd, git: gitContextForPath(cwd) };
}

function activeHostPayloads(hosts: readonly HostRegistryEntry[]): RegisteredHostPayload[] {
  return hosts
    .filter((host) => host.status === "active")
    .map((host) => ({ name: host.name, capabilities: host.capabilities }));
}

function existingSessionWarnings(cwd: string): SessionWarning[] {
  if (!existsSync(DB_PATH()) || !existsSync(CATALOGUE_PATH())) return [];
  try {
    const index = openIndex(DB_PATH());
    const catalogue = new Database(CATALOGUE_PATH(), { readonly: true });
    try {
      const warnings: SessionWarning[] = [];
      const stateQuery = catalogue.query(
        `SELECT session_class AS sessionClass, completed, archived, parked_task_id AS parkedTaskId
         FROM catalogue WHERE session_id = $sessionId`,
      );
      for (const session of listByRecency(index)) {
        if (session.cwd !== cwd && session.projectRoot !== cwd) continue;
        const row = stateQuery.get({ $sessionId: session.sessionId }) as {
          sessionClass: string | null;
          completed: number;
          archived: number;
          parkedTaskId: string | null;
        } | null;
        if (!row || row.sessionClass !== "work_body" || row.completed !== 0 || row.archived !== 0 || row.parkedTaskId) continue;
        warnings.push({ sessionId: session.sessionId, title: session.title, lifecycle: "idle" });
        if (warnings.length >= 5) break;
      }
      return warnings;
    } finally {
      index.close();
      catalogue.close();
    }
  } catch {
    return [];
  }
}

function locationPayload(
  registry: LocationRegistry,
  location: LaunchLocation,
  host: string,
  currentHost: string,
  registeredHost: HostRegistryEntry | null,
): LocationPayload {
  const resolved = resolveLocationForHost(location, host);
  const defaults = effectiveLocationDefaults(registry, location);
  return {
    key: location.key,
    host,
    current_host: currentHost,
    name: location.name,
    aliases: location.aliases,
    cwd: resolved.ok ? resolved.value.cwd : location.cwd,
    kind: location.kind,
    eligible_hosts: location.eligibleHosts,
    preferred_host: location.preferredHost,
    host_capabilities: registeredHost?.capabilities ?? [],
    declared_default_harness: location.defaultHarness,
    declared_default_model: location.defaultModel,
    default_harness: defaults.defaultHarness,
    default_model: defaults.defaultModel,
    status: location.status,
    host_eligible: resolved.ok,
    validation_error: resolved.ok ? null : resolved.error.message,
    git_state: resolved.ok && location.kind === "repo" ? gitContextForPath(resolved.value.cwd) : null,
  };
}

export function locationCommand(args: string[], dependencies: LocationCommandDependencies = {}): number {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") return usage(subcommand ? 0 : 1);
  const config = configOrError();
  if (!config) return 2;
  const parsed = parseArgs(args.slice(1));
  switch (subcommand) {
    case "list":
    case "ls": return listCommand(config, parsed);
    case "show": return showCommand(config, parsed);
    case "match": return matchCommand(config, parsed);
    case "register": return registerCommand(config, parsed, dependencies);
    case "retire": return retireCommand(config, parsed);
    default:
      console.error(`ccs location: unknown command "${subcommand}"`);
      return usage(1);
  }
}

function usage(exitCode: number): number {
  console.error("ccs location: curated launch locations");
  console.error("");
  console.error("  ccs location list [--json] [--all]");
  console.error("  ccs location show <key> [--json] [--host <host>]");
  console.error("  ccs location match <request> [--json] [--host <host>]");
  console.error("  ccs location register <key> --cwd <absolute-path> [--name <name>] [--alias <text>]...");
  console.error("      [--kind root|workspace|repo|config] [--eligible-host <host>]... [--preferred-host <host>]");
  console.error("      [--default-harness <launcher>] [--default-model <model>]");
  console.error("  ccs location retire <key> [--json]");
  return exitCode;
}

function load(config: Config) {
  const loaded = loadLocationRegistry(config.routing.registry);
  if (!loaded.ok) console.error(`ccs location: ${loaded.error.message}`);
  return loaded;
}

function loadHosts(config: Config): readonly HostRegistryEntry[] | null {
  const loaded = loadHostRegistry(config.routing.hosts);
  if (!loaded.ok) {
    console.error(`ccs location: ${loaded.error.message}`);
    return null;
  }
  return loaded.value.hosts;
}

function listCommand(config: Config, parsed: ParsedArgs): number {
  const loaded = load(config);
  if (!loaded.ok) return 2;
  const locations = loaded.value.locations.filter((location) => parsed.booleans.has("all") || location.status === "active");
  if (parsed.booleans.has("json")) {
    console.log(JSON.stringify({ registry: config.routing.registry, locations }, null, 2));
    return 0;
  }
  for (const location of locations) {
    const aliases = location.aliases.length > 0 ? ` (${location.aliases.join(", ")})` : "";
    console.log(`${location.key}\t${location.cwd}\t${location.status}\t${location.name}${aliases}`);
  }
  return 0;
}

function showCommand(config: Config, parsed: ParsedArgs): number {
  const key = parsed.positional[0];
  if (!key) return usage(1);
  const loaded = load(config);
  if (!loaded.ok) return 2;
  const location = locationByKey(loaded.value, key);
  if (!location) {
    console.error(`ccs location show: unknown location "${key}"`);
    return 1;
  }
  const hosts = loadHosts(config);
  if (!hosts) return 2;
  const host = first(parsed, "host") ?? config.host.label;
  const registeredHost = activeHostByCanonicalName({ version: 1 as const, hosts }, host);
  const payload = locationPayload(loaded.value, location, host, config.host.label, registeredHost);
  if (parsed.booleans.has("json")) {
    console.log(JSON.stringify({
      ...payload,
      registered_hosts: activeHostPayloads(hosts),
      caller_context: callerContext(),
    }, null, 2));
  } else {
    for (const [field, value] of Object.entries(payload)) {
      const rendered = Array.isArray(value)
        ? value.join(", ")
        : typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : String(value ?? "-");
      console.log(`${field}: ${rendered}`);
    }
  }
  return 0;
}

function matchCommand(config: Config, parsed: ParsedArgs): number {
  const query = first(parsed, "query") ?? parsed.positional.join(" ");
  if (!query.trim()) {
    console.error("ccs location match: missing request");
    return 1;
  }
  const loaded = load(config);
  if (!loaded.ok) return 2;
  const hosts = loadHosts(config);
  if (!hosts) return 2;
  const host = first(parsed, "host") ?? config.host.label;
  const registeredHost = activeHostByCanonicalName({ version: 1 as const, hosts }, host);
  const candidates = matchLocations(loaded.value, query).slice(0, 8).map((match) => {
    const resolved = resolveLocationForHost(match.location, host);
    const warnings = resolved.ok ? existingSessionWarnings(resolved.value.cwd) : [];
    return {
      ...locationPayload(loaded.value, match.location, host, config.host.label, registeredHost),
      key: match.location.key,
      cwd: resolved.ok ? resolved.value.cwd : match.location.cwd,
      score: match.score,
      matched_on: match.matchedOn,
      existing_session_warnings: warnings,
    };
  });
  const payload = {
    request: query,
    host,
    fresh_only: true,
    default_harness: loaded.value.defaultHarness,
    default_model: loaded.value.defaultModel,
    registered_hosts: activeHostPayloads(hosts),
    caller_context: callerContext(),
    candidates,
  };
  if (parsed.booleans.has("json")) console.log(JSON.stringify(payload, null, 2));
  else {
    for (const candidate of candidates) {
      const warning = candidate.existing_session_warnings.length > 0
        ? `; ${candidate.existing_session_warnings.length} related idle session(s)`
        : "";
      console.log(`${candidate.key}\t${candidate.score.toFixed(2)}\t${candidate.cwd}${warning}`);
    }
  }
  return candidates.length > 0 ? 0 : 3;
}

function registerCommand(
  config: Config,
  parsed: ParsedArgs,
  dependencies: LocationCommandDependencies,
): number {
  const key = parsed.positional[0];
  const cwd = first(parsed, "cwd");
  if (!key || !cwd) {
    console.error("ccs location register: require <key> and --cwd <absolute-path>");
    return 1;
  }
  const kind = first(parsed, "kind") ?? "repo";
  if (kind !== "root" && kind !== "workspace" && kind !== "repo" && kind !== "config") {
    console.error(`ccs location register: invalid --kind "${kind}"`);
    return 1;
  }
  const defaultHarness = first(parsed, "default-harness") ?? null;
  const defaultModel = first(parsed, "default-model") ?? null;
  if (Boolean(defaultHarness) !== Boolean(defaultModel)) {
    console.error("ccs location register: --default-harness and --default-model must be supplied together");
    return 1;
  }
  if (defaultHarness && defaultModel) {
    const compiled = compileLocationModelLaunch(defaultHarness, defaultModel);
    if (!compiled.ok) {
      console.error(`ccs location register: ${compiled.error.message}`);
      return 2;
    }
  }
  const result = registerLocation(config.routing.registry, {
    defaultHost: config.host.label,
    key,
    name: first(parsed, "name") ?? key,
    aliases: parsed.values.get("alias") ?? [],
    cwd,
    kind: kind as LocationKind,
    eligibleHosts: parsed.values.get("eligible-host") ?? [config.host.label],
    preferredHost: first(parsed, "preferred-host") ?? null,
    defaultHarness,
    defaultModel,
  }, dependencies.registrationPathPolicy);
  if (!result.ok) {
    console.error(`ccs location register: ${result.error.message}`);
    return 2;
  }
  console.log(JSON.stringify({ status: "registered", location: result.value }, null, 2));
  return 0;
}

function retireCommand(config: Config, parsed: ParsedArgs): number {
  const key = parsed.positional[0];
  if (!key) {
    console.error("ccs location retire: missing <key>");
    return 1;
  }
  const result = retireLocation(config.routing.registry, key);
  if (!result.ok) {
    console.error(`ccs location retire: ${result.error.message}`);
    return 2;
  }
  if (parsed.booleans.has("json")) console.log(JSON.stringify({ status: "retired", location: result.value }, null, 2));
  else console.log(`retired ${result.value.key}: ${result.value.cwd}`);
  return 0;
}
