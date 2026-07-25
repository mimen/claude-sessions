import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { expandHome } from "../paths.ts";
import { type Result, err, ok } from "../result.ts";

export type LocationKind = "root" | "workspace" | "repo" | "config";
export type LocationStatus = "active" | "retired";

export interface LaunchLocation {
  readonly key: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly cwd: string;
  readonly kind: LocationKind;
  readonly eligibleHosts: readonly string[];
  readonly preferredHost: string;
  readonly defaultHarness: string | null;
  readonly defaultModel: string | null;
  readonly status: LocationStatus;
}

export interface LocationRegistry {
  readonly version: number;
  readonly defaultHost: string;
  readonly defaultHarness: string | null;
  readonly defaultModel: string | null;
  readonly locations: readonly LaunchLocation[];
}

export interface EffectiveLocationDefaults {
  readonly defaultHarness: string | null;
  readonly defaultModel: string | null;
}

export interface ResolvedLocation extends LaunchLocation {
  readonly cwd: string;
}

export interface LocationMatch {
  readonly location: LaunchLocation;
  readonly score: number;
  readonly matchedOn: string;
}

export interface RegisterLocationInput {
  readonly defaultHost: string;
  readonly key: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly cwd: string;
  readonly kind: LocationKind;
  readonly eligibleHosts: readonly string[];
  readonly preferredHost: string | null;
  readonly defaultHarness: string | null;
  readonly defaultModel: string | null;
}

export interface RegistrationPathPolicy {
  /** Override only for isolated tests whose fixtures live under the operating-system temp root. */
  readonly temporaryRoots?: readonly string[];
}

const KeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "expected kebab-case characters: a-z, 0-9, -");
const RawLocationSchema = z.object({
  key: KeySchema,
  name: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).default([]),
  cwd: z.string().trim().min(1),
  kind: z.enum(["root", "workspace", "repo", "config"]),
  eligible_hosts: z.array(z.string().trim().min(1)).min(1),
  preferred_host: z.string().trim().min(1),
  default_harness: z.string().trim().min(1).optional(),
  default_model: z.string().trim().min(1).optional(),
  status: z.enum(["active", "retired"]).default("active"),
}).strict();
const RawRegistrySchema = z.object({
  version: z.literal(1),
  default_host: z.string().trim().min(1),
  default_harness: z.string().trim().min(1).optional(),
  default_model: z.string().trim().min(1).optional(),
  location: z.array(RawLocationSchema).default([]),
}).strict();

type RawLocation = z.infer<typeof RawLocationSchema>;

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function toLocation(raw: RawLocation): LaunchLocation {
  return {
    key: raw.key,
    name: raw.name,
    aliases: raw.aliases,
    cwd: raw.cwd,
    kind: raw.kind,
    eligibleHosts: raw.eligible_hosts,
    preferredHost: raw.preferred_host,
    defaultHarness: raw.default_harness ?? null,
    defaultModel: raw.default_model ?? null,
    status: raw.status,
  };
}

function toRawLocation(location: LaunchLocation): RawLocation {
  return {
    key: location.key,
    name: location.name,
    aliases: [...location.aliases],
    cwd: location.cwd,
    kind: location.kind,
    eligible_hosts: [...location.eligibleHosts],
    preferred_host: location.preferredHost,
    ...(location.defaultHarness ? { default_harness: location.defaultHarness } : {}),
    ...(location.defaultModel ? { default_model: location.defaultModel } : {}),
    status: location.status,
  };
}

function selectorTerms(location: LaunchLocation): readonly string[] {
  return [location.key, location.name, ...location.aliases];
}

function validRegistryCwd(cwd: string): boolean {
  if (cwd !== "~" && !cwd.startsWith("~/") && !isAbsolute(cwd)) return false;
  const rendered = cwd.startsWith("~/") ? cwd.slice(2) : cwd;
  return !rendered.split("/").includes("..");
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function includesIdentifier(values: readonly string[], expected: string): boolean {
  const normalizedExpected = normalizeIdentifier(expected);
  return values.some((value) => normalizeIdentifier(value) === normalizedExpected);
}

function validateRegistry(registry: LocationRegistry): Result<void> {
  if (Boolean(registry.defaultHarness) !== Boolean(registry.defaultModel)) {
    return err(new Error("registry must declare default_harness and default_model together, or omit both"));
  }

  const keys = new Set<string>();
  const activeSelectors = new Map<string, string>();
  for (const location of registry.locations) {
    if (keys.has(location.key)) return err(new Error(`duplicate location key "${location.key}"`));
    keys.add(location.key);

    if (!validRegistryCwd(location.cwd)) {
      return err(new Error(`location "${location.key}" cwd must be absolute, "~", or home-relative without "..": ${location.cwd}`));
    }
    const normalizedHosts = location.eligibleHosts.map(normalizeIdentifier);
    if (new Set(normalizedHosts).size !== normalizedHosts.length) {
      return err(new Error(`location "${location.key}" eligible_hosts contains duplicates`));
    }
    if (!includesIdentifier(location.eligibleHosts, location.preferredHost)) {
      return err(new Error(
        `location "${location.key}" preferred_host "${location.preferredHost}" must be a member of eligible_hosts`,
      ));
    }
    if (location.eligibleHosts.includes("*")) {
      return err(new Error(`location "${location.key}" eligible_hosts must use exact machine hostnames`));
    }
    if (Boolean(location.defaultHarness) !== Boolean(location.defaultModel)) {
      return err(new Error(
        `location "${location.key}" must declare default_harness and default_model together, or omit both`,
      ));
    }

    if (location.status !== "active") continue;
    for (const term of selectorTerms(location)) {
      const normalized = normalize(term);
      const prior = activeSelectors.get(normalized);
      if (prior && prior !== location.key) {
        const label = location.aliases.includes(term) ? "alias" : "selector";
        return err(new Error(`${label} "${term}" collides between locations "${prior}" and "${location.key}"`));
      }
      activeSelectors.set(normalized, location.key);
    }
  }

  if (
    registry.locations.length > 0 &&
    !registry.locations.some((location) => includesIdentifier(location.eligibleHosts, registry.defaultHost))
  ) {
    return err(new Error(`default_host "${registry.defaultHost}" is not eligible for any location`));
  }
  return ok(undefined);
}

export function loadLocationRegistry(path: string): Result<LocationRegistry> {
  try {
    const raw = parseToml(readFileSync(path, "utf8"));
    const parsed = RawRegistrySchema.safeParse(raw);
    if (!parsed.success) {
      return err(new Error(`Invalid location registry at ${path}:\n${z.prettifyError(parsed.error)}`));
    }
    const registry: LocationRegistry = {
      version: parsed.data.version,
      defaultHost: parsed.data.default_host,
      defaultHarness: parsed.data.default_harness ?? null,
      defaultModel: parsed.data.default_model ?? null,
      locations: parsed.data.location.map(toLocation),
    };
    const validation = validateRegistry(registry);
    if (!validation.ok) return validation;
    return ok(registry);
  } catch (error) {
    return err(new Error(`Failed to read location registry at ${path}: ${(error as Error).message}`));
  }
}

function loadRegistryForWrite(path: string, defaultHost: string): Result<LocationRegistry> {
  if (!existsSync(path)) {
    return ok({ version: 1, defaultHost, defaultHarness: null, defaultModel: null, locations: [] });
  }
  return loadLocationRegistry(path);
}

export function locationByKey(registry: LocationRegistry, key: string): LaunchLocation | null {
  return registry.locations.find((location) => location.key === key) ?? null;
}

export function effectiveLocationDefaults(
  registry: LocationRegistry,
  location: LaunchLocation,
): EffectiveLocationDefaults {
  return {
    defaultHarness: location.defaultHarness ?? registry.defaultHarness,
    defaultModel: location.defaultModel ?? registry.defaultModel,
  };
}

export function validateLocationHostEligibility(location: LaunchLocation, host: string): Result<void> {
  if (location.status !== "active") return err(new Error(`location "${location.key}" is retired`));
  if (!includesIdentifier(location.eligibleHosts, host)) {
    return err(new Error(`location "${location.key}" is not eligible on host "${host}"`));
  }
  return ok(undefined);
}

function gitRoot(path: string): Result<string> {
  try {
    const output = execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) return err(new Error(`git returned a blank repository root for ${path}`));
    return ok(realpathSync(output));
  } catch {
    return err(new Error(`cwd is not a Git repository root: ${path}`));
  }
}

const DEFAULT_REGISTRATION_TEMPORARY_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp"] as const;

function canonicalPath(path: string): string | null {
  try {
    return realpathSync(expandHome(path));
  } catch {
    return null;
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder));
}

function linkedGitWorktree(path: string): boolean {
  try {
    const output = execFileSync("git", ["-C", path, "rev-parse", "--git-dir", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const [gitDirOutput, commonDirOutput] = output.split("\n");
    if (!gitDirOutput || !commonDirOutput) return false;
    const gitDir = realpathSync(resolve(path, gitDirOutput));
    const commonDir = realpathSync(resolve(path, commonDirOutput));
    return gitDir !== commonDir;
  } catch {
    return false;
  }
}

function taskLocalPath(path: string): boolean {
  const components = path.split(sep).filter(Boolean);
  for (let index = 0; index < components.length; index++) {
    if (components[index] === ".worktrees") return true;
    if (components[index] === ".claude" && components[index + 1] === "worktrees") return true;
  }
  return false;
}

export function validateRegistrationPath(
  path: string,
  policy: RegistrationPathPolicy = {},
): Result<void> {
  if (linkedGitWorktree(path)) {
    return err(new Error(`registration cwd is a linked Git worktree and cannot be durable: ${path}`));
  }
  if (taskLocalPath(path)) {
    return err(new Error(`registration cwd is task-local and cannot be durable: ${path}`));
  }
  const temporaryRoots = policy.temporaryRoots ?? DEFAULT_REGISTRATION_TEMPORARY_ROOTS;
  const canonicalRoots = temporaryRoots
    .map(canonicalPath)
    .filter((root): root is string => root !== null);
  if (canonicalRoots.some((root) => pathIsWithin(root, path))) {
    return err(new Error(`registration cwd is temporary and cannot be durable: ${path}`));
  }
  return ok(undefined);
}

export function resolveLocationForHost(location: LaunchLocation, host: string): Result<ResolvedLocation> {
  const eligible = validateLocationHostEligibility(location, host);
  if (!eligible.ok) return eligible;
  const expanded = expandHome(location.cwd);
  if (!existsSync(expanded)) return err(new Error(`location "${location.key}" cwd does not exist: ${expanded}`));
  if (!lstatSync(expanded).isDirectory()) return err(new Error(`location "${location.key}" cwd is not a directory: ${expanded}`));
  const cwd = realpathSync(expanded);
  if (location.kind === "repo") {
    const root = gitRoot(cwd);
    if (!root.ok) return err(new Error(`location "${location.key}" ${root.error.message}`));
    if (root.value !== cwd) {
      return err(new Error(`location "${location.key}" cwd is not the Git repository root: ${cwd} (root ${root.value})`));
    }
  }
  return ok({ ...location, cwd });
}

function matchScore(query: string, term: string): number {
  const normalizedQuery = normalize(query);
  const normalizedTerm = normalize(term);
  if (!normalizedQuery || !normalizedTerm) return 0;
  if (normalizedQuery === normalizedTerm) return 1;
  if (normalizedQuery.includes(normalizedTerm)) return 0.96;
  if (normalizedTerm.includes(normalizedQuery)) return 0.86;
  const queryTokens = new Set(normalizedQuery.split(" "));
  const termTokens = new Set(normalizedTerm.split(" "));
  let overlap = 0;
  for (const token of termTokens) if (queryTokens.has(token)) overlap++;
  if (overlap === 0) return 0;
  return 0.75 * (overlap / Math.max(queryTokens.size, termTokens.size));
}

export function matchLocations(registry: LocationRegistry, query: string): LocationMatch[] {
  const expandedQuery = expandHome(query.trim());
  const matches: LocationMatch[] = [];
  for (const location of registry.locations) {
    if (location.status !== "active") continue;
    let score = 0;
    let matchedOn = "";
    const expandedCwd = expandHome(location.cwd);
    if (query.trim() === location.cwd || expandedQuery === expandedCwd) {
      score = 1;
      matchedOn = "cwd";
    }
    for (const term of selectorTerms(location)) {
      const termScore = matchScore(query, term);
      if (termScore > score) {
        score = termScore;
        matchedOn = term;
      }
    }
    if (score > 0) matches.push({ location, score, matchedOn });
  }
  return matches.sort((a, b) => b.score - a.score || a.location.name.localeCompare(b.location.name));
}

function registryDestination(path: string): Result<string> {
  // Machine adapter normally exposes the shared vault registry through ~/.ccs/locations.toml.
  // lstat must inspect the managed link itself: existsSync follows links and returns false when
  // their target is missing, which would otherwise let an atomic rename replace the link.
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok(path);
    return err(new Error(`Failed to inspect location registry at ${path}: ${(error as Error).message}`));
  }
  if (!metadata.isSymbolicLink()) return ok(path);

  try {
    const destination = realpathSync(path);
    accessSync(destination, constants.R_OK);
    if (!statSync(destination).isFile()) throw new Error("target is not a regular file");
    return ok(destination);
  } catch (error) {
    return err(new Error(
      `Managed location registry symlink at ${path} has a missing or unreadable target; ` +
        `restore the managed target before registering locations (${(error as Error).message})`,
    ));
  }
}

function writeRegistryContent(path: string, content: string): Result<void> {
  try {
    const resolved = registryDestination(path);
    if (!resolved.ok) return resolved;
    const destination = resolved.value;
    mkdirSync(dirname(destination), { recursive: true });
    const mode = existsSync(destination) ? statSync(destination).mode & 0o777 : 0o600;
    const temp = `${destination}.tmp-${process.pid}`;
    writeFileSync(temp, content, { mode });
    renameSync(temp, destination);
    return ok(undefined);
  } catch (error) {
    return err(new Error(`Failed to write location registry at ${path}: ${(error as Error).message}`));
  }
}

function renderRegistry(registry: LocationRegistry): string {
  const content = stringifyToml({
    version: registry.version,
    default_host: registry.defaultHost,
    ...(registry.defaultHarness ? { default_harness: registry.defaultHarness } : {}),
    ...(registry.defaultModel ? { default_model: registry.defaultModel } : {}),
    location: registry.locations.map(toRawLocation),
  });
  return `${content.trimEnd()}\n`;
}

function appendLocationContent(content: string, location: LaunchLocation): string {
  const rendered = stringifyToml({ location: [toRawLocation(location)] }).trim();
  const separator = content.length === 0 || content.endsWith("\n\n")
    ? ""
    : content.endsWith("\n")
    ? "\n"
    : "\n\n";
  return `${content}${separator}${rendered}\n`;
}

function retireLocationContent(content: string, key: string): Result<string> {
  const sections = content.split(/(?=^\[\[location\]\][ \t]*(?:#.*)?$)/m);
  let found = false;
  const updated = sections.map((section) => {
    const match = section.match(/^key\s*=\s*["']([^"']+)["']/m);
    if (!match || match[1] !== key) return section;
    found = true;
    const statusPattern = /^(\s*status\s*=\s*)(["'])(active|retired)\2(.*)$/m;
    if (statusPattern.test(section)) {
      return section.replace(statusPattern, '$1"retired"$4');
    }
    const suffix = section.endsWith("\n") ? "" : "\n";
    return `${section}${suffix}status = "retired"\n`;
  });
  return found ? ok(updated.join("")) : err(new Error(`unknown location: ${key}`));
}

export function registerLocation(
  path: string,
  input: RegisterLocationInput,
  registrationPolicy: RegistrationPathPolicy = {},
): Result<LaunchLocation> {
  const key = input.key.trim();
  const keyResult = KeySchema.safeParse(key);
  if (!keyResult.success) return err(new Error(`invalid location key "${key}": ${z.prettifyError(keyResult.error)}`));

  const defaultHost = input.defaultHost.trim();
  if (!defaultHost) return err(new Error("registration default host must not be empty"));
  const expanded = expandHome(input.cwd);
  if (!existsSync(expanded)) return err(new Error(`registration cwd does not exist: ${expanded}`));
  if (!lstatSync(expanded).isDirectory()) return err(new Error(`registration cwd is not a directory: ${expanded}`));
  const cwd = realpathSync(expanded);
  const registrationPath = validateRegistrationPath(cwd, registrationPolicy);
  if (!registrationPath.ok) return registrationPath;

  const destination = registryDestination(path);
  if (!destination.ok) return destination;
  const registryExists = existsSync(destination.value);
  const loaded = loadRegistryForWrite(destination.value, defaultHost);
  if (!loaded.ok) return loaded;
  const eligibleHosts = input.eligibleHosts.map((host) => host.trim()).filter(Boolean);
  const preferredHost = input.preferredHost?.trim() || eligibleHosts[0] || defaultHost;
  const location: LaunchLocation = {
    key,
    name: input.name.trim(),
    aliases: input.aliases.map((alias) => alias.trim()).filter(Boolean),
    cwd,
    kind: input.kind,
    eligibleHosts: eligibleHosts.length > 0 ? eligibleHosts : [defaultHost],
    preferredHost,
    defaultHarness: input.defaultHarness?.trim() || null,
    defaultModel: input.defaultModel?.trim() || null,
    status: "active",
  };
  if (!location.name) return err(new Error("registration name must not be empty"));
  if (loaded.value.locations.some((existing) => existing.key === key)) {
    return err(new Error(`location key already registered: ${key}`));
  }
  if (loaded.value.locations.some((existing) => expandHome(existing.cwd) === location.cwd)) {
    return err(new Error(`cwd already registered: ${location.cwd}`));
  }
  const next: LocationRegistry = {
    version: loaded.value.version,
    defaultHost: loaded.value.defaultHost,
    defaultHarness: loaded.value.defaultHarness,
    defaultModel: loaded.value.defaultModel,
    locations: [...loaded.value.locations, location],
  };
  const validation = validateRegistry(next);
  if (!validation.ok) return validation;
  const resolved = resolveLocationForHost(location, preferredHost);
  if (!resolved.ok) return resolved;
  const content = registryExists
    ? appendLocationContent(readFileSync(destination.value, "utf8"), location)
    : renderRegistry(next);
  const written = writeRegistryContent(path, content);
  if (!written.ok) return written;
  return ok(location);
}

export function retireLocation(path: string, key: string): Result<LaunchLocation> {
  const loaded = loadLocationRegistry(path);
  if (!loaded.ok) return loaded;
  const existing = locationByKey(loaded.value, key);
  if (!existing) return err(new Error(`unknown location: ${key}`));
  const retired: LaunchLocation = { ...existing, status: "retired" };
  const next: LocationRegistry = {
    version: loaded.value.version,
    defaultHost: loaded.value.defaultHost,
    defaultHarness: loaded.value.defaultHarness,
    defaultModel: loaded.value.defaultModel,
    locations: loaded.value.locations.map((location) => location.key === key ? retired : location),
  };
  const validation = validateRegistry(next);
  if (!validation.ok) return validation;
  const destination = registryDestination(path);
  if (!destination.ok) return destination;
  const content = retireLocationContent(readFileSync(destination.value, "utf8"), key);
  if (!content.ok) return content;
  const written = writeRegistryContent(path, content.value);
  if (!written.ok) return written;
  return ok(retired);
}
