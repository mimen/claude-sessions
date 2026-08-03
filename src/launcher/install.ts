import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runtimeRoot } from "../paths.ts";
import { err, ok, type Result } from "../result.ts";
import { loadConfig, type Config } from "../config.ts";
import { effectiveLaunchers, type Launcher } from "../resume/launchers.ts";
import { loadLauncherRegistry } from "./registry.ts";
import { loadLocationRegistry } from "../locations/registry.ts";
import { compileLauncherEnvSpec, launcherEnvSpecFilename } from "./environment.ts";

const START_MARKER = "# >>> CCS managed Claude launcher >>>";
const END_MARKER = "# <<< CCS managed Claude launcher <<<";

/** Filename holding the default launcher name the shim reads when CCS_FORCE_HARNESS is unset. */
const DEFAULT_LAUNCHER_FILE = "default";

export interface ClaudeShimInstallation {
  readonly shimPath: string;
  readonly shellInitPath: string;
  readonly zshrcPath: string;
  readonly launcherEnvDir: string;
  /** Launcher names whose specs were materialized, in config order. */
  readonly launchers: readonly string[];
  /** The launcher `claude` resolves to with no CCS_FORCE_HARNESS; null when undeclared. */
  readonly defaultLauncher: string | null;
}

export interface ClaudeShimInstallOptions {
  readonly sourcePath?: string;
  readonly root?: string;
  readonly zshrcPath?: string;
  /** Injected for tests; production reads ~/.ccs/config.toml. */
  readonly config?: Config;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function managedZshrcBlock(shellInitPath: string): string {
  return `${START_MARKER}\n[ -f ${shellSingleQuote(shellInitPath)} ] && source ${shellSingleQuote(shellInitPath)}\n${END_MARKER}`;
}

export function updateZshrc(content: string, shellInitPath: string): string {
  const block = managedZshrcBlock(shellInitPath);
  const start = content.indexOf(START_MARKER);
  const end = content.indexOf(END_MARKER);
  if (start !== -1 && end !== -1 && end >= start) {
    const after = end + END_MARKER.length;
    return `${content.slice(0, start)}${block}${content.slice(after)}`;
  }
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}\n${block}\n`;
}

/**
 * The launcher `claude` resolves to when nothing forces one.
 *
 * DELIBERATELY the location registry's `default_harness` — the value that already decides which
 * launcher a CCS-managed BIRTH lands on. Interactive `claude` and managed births are the same
 * question ("which harness is the fleet on right now?"), and answering it twice is how they drift
 * apart. Reusing it makes moving the fleet exactly one edit, and makes the escape hatch back to
 * `claude-native` exactly one edit too. A second key here would have to be kept in sync with the
 * registry by hand, and the failure mode — interactive sessions on one harness, births on another
 * — is silent.
 *
 * Null (no registry configured, or none declared) means the shim applies no environment and the
 * raw binary launches on its own defaults, which is precisely today's behavior.
 */
function resolveDefaultLauncher(
  config: Config,
  launchers: readonly Launcher[],
  fleetDeclared: boolean,
): Result<string | null> {
  // An undeclared fleet (neither the shared registry nor `[[launcher]]` entries) means `launchers`
  // is the hardcoded `claude` fallback. There is nothing to point a default at, and `launcher
  // install` must stay usable on such a host — the feature is invisible until a fleet exists.
  if (!fleetDeclared) return ok(null);
  const registryPath = config.routing.registry;
  if (!registryPath || !existsSync(registryPath)) return ok(null);
  const registry = loadLocationRegistry(registryPath);
  if (!registry.ok) return registry;
  const harness = registry.value.defaultHarness;
  if (!harness) return ok(null);
  if (!launchers.some((launcher) => launcher.name === harness)) {
    return err(new Error(
      `location registry default_harness "${harness}" has no launcher entry in the shared registry ` +
        `or config.toml; declared launchers: ${launchers.map((l) => l.name).join(", ")}`,
    ));
  }
  return ok(harness);
}

/**
 * Write every launcher's spec, then remove specs for launchers config no longer declares. Stale
 * files are deleted rather than left: a removed launcher must stop resolving, not keep working
 * from a file nothing regenerates.
 */
function materializeLauncherEnv(
  directory: string,
  launchers: readonly Launcher[],
  defaultLauncher: string | null,
): Result<void> {
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o700);

  const written = new Set<string>();
  for (const launcher of launchers) {
    const filename = launcherEnvSpecFilename(launcher.name);
    if (!filename.ok) return filename;
    const spec = compileLauncherEnvSpec({
      name: launcher.name,
      env: launcher.env,
      clears: launcher.clears,
    });
    if (!spec.ok) return spec;
    // 0600: a spec may name a secret's path, and on this host the whole tree is private anyway.
    writeFileSync(join(directory, filename.value), spec.value, { encoding: "utf8", mode: 0o600 });
    written.add(filename.value);
  }

  if (defaultLauncher === null) {
    rmSync(join(directory, DEFAULT_LAUNCHER_FILE), { force: true });
  } else {
    writeFileSync(join(directory, DEFAULT_LAUNCHER_FILE), `${defaultLauncher}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    written.add(DEFAULT_LAUNCHER_FILE);
  }

  for (const entry of readdirSync(directory)) {
    if (!written.has(entry)) rmSync(join(directory, entry), { force: true, recursive: true });
  }
  return ok(undefined);
}

export function installClaudeShim(
  options: ClaudeShimInstallOptions = {},
): Result<ClaudeShimInstallation> {
  const root = options.root ?? runtimeRoot();
  const sourcePath = options.sourcePath ?? resolve(import.meta.dir, "../../bin/ccs-claude-shim");
  const shimPath = join(root, "bin", "claude");
  const shellInitPath = join(root, "shell", "launcher.zsh");
  const launcherEnvDir = join(root, "launcher-env");
  const zshrcPath = options.zshrcPath ?? join(homedir(), ".zshrc");

  const config = options.config ? ok(options.config) : loadConfig();
  if (!config.ok) return config;
  // The SHARED (vault-backed) fleet folded with this machine's overrides — the same list every
  // spawn path routes on, so the materialized specs can never describe a different fleet.
  const launchers = effectiveLaunchers(config.value);
  if (!launchers.ok) return launchers;
  const sharedRegistry = loadLauncherRegistry(config.value.routing.launchers);
  if (!sharedRegistry.ok) return sharedRegistry;
  const fleetDeclared =
    config.value.launcher.length > 0 || (sharedRegistry.value?.launcher.length ?? 0) > 0;
  const defaultLauncher = resolveDefaultLauncher(config.value, launchers.value, fleetDeclared);
  if (!defaultLauncher.ok) return defaultLauncher;

  try {
    mkdirSync(dirname(shimPath), { recursive: true });
    mkdirSync(dirname(shellInitPath), { recursive: true });
    copyFileSync(sourcePath, shimPath);
    chmodSync(shimPath, 0o755);

    const materialized = materializeLauncherEnv(
      launcherEnvDir,
      launchers.value,
      defaultLauncher.value,
    );
    if (!materialized.ok) return materialized;
    writeFileSync(
      shellInitPath,
      [
        "# Generated by `ccs launcher install`.",
        "# The PATH-precedent pass captures causal parentage before cmux clears Claude's",
        "# inherited session identity; CMUX_CUSTOM_CLAUDE_PATH routes back for registration.",
        `export PATH=${shellSingleQuote(dirname(shimPath))}:\"$PATH\"`,
        `export CMUX_CUSTOM_CLAUDE_PATH=${shellSingleQuote(shimPath)}`,
        "",
      ].join("\n"),
      { mode: 0o644 },
    );

    let zshrc = "";
    try {
      zshrc = readFileSync(zshrcPath, "utf8");
    } catch {
      // A missing zshrc is a valid fresh-machine state.
    }
    writeFileSync(zshrcPath, updateZshrc(zshrc, shellInitPath));
    return ok({
      shimPath,
      shellInitPath,
      zshrcPath,
      launcherEnvDir,
      launchers: launchers.value.map((launcher) => launcher.name),
      defaultLauncher: defaultLauncher.value,
    });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
