/**
 * The I/O half of `ccs doctor launcher`: read the deployed checkout's git state and the installed
 * artifacts, then hand pure facts to `buildLauncherDriftReport`.
 *
 * Every read here is best-effort and non-throwing. A diagnostic that crashes because git is absent
 * or a file is unreadable tells the operator nothing; an "unreadable" finding tells them exactly
 * what to look at, which is the distinction ADR-0066 draws between absent and unreadable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig, type Config } from "../config.ts";
import { compileLauncherEnvSpec, launcherEnvSpecFilename } from "../launcher/environment.ts";
import {
  launcherShellInitContents,
  managedZshrcBlock,
  resolveDefaultLauncher,
} from "../launcher/install.ts";
import { loadLauncherRegistry } from "../launcher/registry.ts";
import { launcherSettingsContents, launcherSettingsFilename } from "../launcher/model-surfaces.ts";
import { displayModelRegistry } from "../models/registry.ts";
import {
  BUNDLED_WRAPPER_BINARIES,
  expectedBundledWrappers,
  wrapperManifestContents,
  WRAPPER_MANIFEST_FILE,
} from "../launcher/wrappers.ts";
import { runtimeRoot } from "../paths.ts";
import { effectiveLaunchers } from "../resume/launchers.ts";
import {
  buildLauncherDriftReport,
  type DeployedRevision,
  type InstalledArtifact,
  type LauncherDriftReport,
} from "./launcher-drift.ts";

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Where the running `ccs` actually lives. `process.argv[1]` is the bin entry; its realpath walks
 * the `bun link` symlink chain to the real checkout, which is the whole point — the deployment
 * that drifted was reached through exactly such a link.
 */
export function deployedCheckoutPath(argv1: string | undefined = process.argv[1]): string | null {
  if (!argv1) return null;
  try {
    const real = realpathSync(resolve(argv1));
    const top = git(dirname(real), ["rev-parse", "--show-toplevel"]);
    return top && top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

/** Read the deployed checkout's revision versus its origin default branch. */
export function readDeployedRevision(path: string | null): DeployedRevision {
  const absent: DeployedRevision = {
    path: null,
    head: null,
    originHead: null,
    behind: null,
    ahead: null,
    dirty: false,
    error: null,
  };
  if (path === null) return absent;

  const head = git(path, ["rev-parse", "HEAD"]);
  if (head === null) {
    return { ...absent, path, error: "git rev-parse HEAD failed" };
  }

  // The origin DEFAULT branch, not the local one: the drift that hid was a local master 75 behind
  // origin, so comparing against the local branch would have reported everything healthy.
  const symbolic = git(path, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const defaultRef = symbolic ?? "refs/remotes/origin/master";
  const originHead = git(path, ["rev-parse", "--verify", "--quiet", defaultRef]);
  const count = (range: string): number | null => {
    if (originHead === null) return null;
    const raw = git(path, ["rev-list", "--count", range]);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const status = git(path, ["status", "--porcelain"]);

  return {
    path,
    head,
    originHead,
    behind: count(`HEAD..${defaultRef}`),
    ahead: count(`${defaultRef}..HEAD`),
    dirty: status !== null && status.length > 0,
    error: null,
  };
}

function readArtifact(
  path: string,
  expected: string,
  expectedMode: number | null,
  match: "exact" | "contains" = "exact",
  allowSymlink = false,
): InstalledArtifact {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, actual: null, expected, expectedMode, actualMode: null, fileType: null, match, unreadable: false };
    }
    return { path, actual: null, expected, expectedMode, actualMode: null, fileType: null, match, unreadable: true };
  }
  let fileType: "file" | "symlink" | "other" =
    stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other";
  if (fileType === "symlink" && allowSymlink) {
    try {
      stat = statSync(path);
      fileType = stat.isFile() ? "file" : "other";
    } catch {
      return {
        path,
        actual: null,
        expected,
        expectedMode,
        actualMode: null,
        fileType: "symlink",
        match,
        unreadable: true,
      };
    }
  }
  if (fileType !== "file") {
    return {
      path,
      actual: null,
      expected,
      expectedMode,
      actualMode: stat.mode & 0o777,
      fileType,
      match,
      unreadable: false,
    };
  }
  try {
    return {
      path,
      actual: readFileSync(path, "utf8"),
      expected,
      expectedMode,
      actualMode: stat.mode & 0o777,
      fileType,
      match,
      unreadable: false,
    };
  } catch {
    return {
      path,
      actual: null,
      expected,
      expectedMode,
      actualMode: stat.mode & 0o777,
      fileType,
      match,
      unreadable: true,
    };
  }
}

export interface LauncherDriftOptions {
  readonly root?: string;
  readonly shimSourcePath?: string;
  readonly wrapperSourceDir?: string;
  readonly zshrcPath?: string;
  readonly argv1?: string;
  /** Injected for tests; production reads ~/.ccs/config.toml. */
  readonly config?: Config;
}

/**
 * Gather everything and build the report. Never throws: a fleet that will not resolve becomes a
 * finding, because "your config is broken" is exactly what a doctor should say out loud.
 */
export function collectLauncherDrift(options: LauncherDriftOptions = {}): LauncherDriftReport {
  const root = options.root ?? runtimeRoot();
  const binDirectory = join(root, "bin");
  const shimPath = join(binDirectory, "claude");
  const shellInitPath = join(root, "shell", "launcher.zsh");
  const zshrcPath = options.zshrcPath ?? join(homedir(), ".zshrc");
  const shimSourcePath =
    options.shimSourcePath ?? resolve(import.meta.dir, "../../bin/ccs-claude-shim");
  const wrapperSourceDir =
    options.wrapperSourceDir ?? resolve(import.meta.dir, "../../bin/wrappers");
  const deployed = readDeployedRevision(deployedCheckoutPath(options.argv1));

  const config = options.config ? { ok: true as const, value: options.config } : loadConfig();
  if (!config.ok) {
    return buildLauncherDriftReport({
      deployed,
      artifacts: [],
      missingSpecs: [],
      unexpectedArtifacts: [],
      fleetError: config.error.message,
    });
  }

  const launchers = effectiveLaunchers(config.value);
  if (!launchers.ok) {
    return buildLauncherDriftReport({
      deployed,
      artifacts: [],
      missingSpecs: [],
      unexpectedArtifacts: [],
      fleetError: launchers.error.message,
    });
  }

  const sharedRegistry = loadLauncherRegistry(config.value.routing.launchers);
  if (!sharedRegistry.ok) {
    return buildLauncherDriftReport({
      deployed,
      artifacts: [],
      missingSpecs: [],
      unexpectedArtifacts: [],
      fleetError: sharedRegistry.error.message,
    });
  }
  const fleetDeclared =
    config.value.launcher.length > 0 || (sharedRegistry.value?.launcher.length ?? 0) > 0;
  const defaultLauncher = resolveDefaultLauncher(config.value, launchers.value, fleetDeclared);
  if (!defaultLauncher.ok) {
    return buildLauncherDriftReport({
      deployed,
      artifacts: [],
      missingSpecs: [],
      unexpectedArtifacts: [],
      fleetError: defaultLauncher.error.message,
    });
  }

  const artifacts: InstalledArtifact[] = [];
  const missingSpecs: string[] = [];
  const launcherEnvDir = join(root, "launcher-env");

  // The shim binary itself: the installed copy must be byte-identical to this build's source, or
  // the live critical path is running code nobody is looking at.
  let shimSource: string;
  try {
    shimSource = readFileSync(shimSourcePath, "utf8");
  } catch (error) {
    return buildLauncherDriftReport({
      deployed,
      artifacts,
      missingSpecs,
      unexpectedArtifacts: [],
      fleetError: `cannot read bundled shim source ${shimSourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  artifacts.push(readArtifact(shimPath, shimSource, 0o755));
  artifacts.push(readArtifact(shellInitPath, launcherShellInitContents(shimPath), 0o644));
  artifacts.push(readArtifact(zshrcPath, managedZshrcBlock(shellInitPath), null, "contains", true));

  const wrappers = expectedBundledWrappers(wrapperSourceDir, binDirectory, launchers.value);
  if (!wrappers.ok) {
    return buildLauncherDriftReport({
      deployed,
      artifacts,
      missingSpecs,
      unexpectedArtifacts: [],
      fleetError: wrappers.error.message,
    });
  }
  for (const wrapper of wrappers.value) {
    artifacts.push(readArtifact(join(binDirectory, wrapper.binary), wrapper.contents, 0o755));
  }
  artifacts.push(readArtifact(
    join(binDirectory, WRAPPER_MANIFEST_FILE),
    wrapperManifestContents(wrappers.value),
    0o600,
  ));
  const expectedWrapperBinaries = new Set(wrappers.value.map((wrapper) => wrapper.binary));
  const unexpectedArtifacts = BUNDLED_WRAPPER_BINARIES
    .filter((binary) => !expectedWrapperBinaries.has(binary))
    .map((binary) => join(binDirectory, binary))
    .filter((path) => existsSync(path));

  const models = displayModelRegistry();
  const expectedEnvFiles = new Set<string>();
  for (const launcher of launchers.value) {
    const filename = launcherEnvSpecFilename(launcher.name);
    const spec = compileLauncherEnvSpec({
      name: launcher.name,
      env: launcher.env,
      clears: launcher.clears,
    });
    if (!filename.ok || !spec.ok) {
      missingSpecs.push(launcher.name);
      continue;
    }
    expectedEnvFiles.add(filename.value);
    const specPath = join(launcherEnvDir, filename.value);
    if (!existsSync(specPath)) {
      missingSpecs.push(launcher.name);
      continue;
    }
    artifacts.push(readArtifact(specPath, spec.value, 0o600));
    const settings = models ? launcherSettingsContents(models, launcher.name) : null;
    if (settings !== null) {
      const settingsFilename = launcherSettingsFilename(launcher.name);
      expectedEnvFiles.add(settingsFilename);
      artifacts.push(readArtifact(join(launcherEnvDir, settingsFilename), settings, 0o600));
    }
  }

  if (defaultLauncher.value !== null) {
    expectedEnvFiles.add("default");
    artifacts.push(readArtifact(
      join(launcherEnvDir, "default"),
      `${defaultLauncher.value}\n`,
      0o600,
    ));
  }
  try {
    for (const entry of readdirSync(launcherEnvDir)) {
      if (!expectedEnvFiles.has(entry)) unexpectedArtifacts.push(join(launcherEnvDir, entry));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return buildLauncherDriftReport({
        deployed,
        artifacts,
        missingSpecs,
        unexpectedArtifacts,
        fleetError: `cannot read launcher environment directory ${launcherEnvDir}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return buildLauncherDriftReport({
    deployed,
    artifacts,
    missingSpecs,
    unexpectedArtifacts,
    fleetError: null,
  });
}
