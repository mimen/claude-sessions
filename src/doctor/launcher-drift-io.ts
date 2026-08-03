/**
 * The I/O half of `ccs doctor launcher`: read the deployed checkout's git state and the installed
 * artifacts, then hand pure facts to `buildLauncherDriftReport`.
 *
 * Every read here is best-effort and non-throwing. A diagnostic that crashes because git is absent
 * or a file is unreadable tells the operator nothing; an "unreadable" finding tells them exactly
 * what to look at, which is the distinction ADR-0066 draws between absent and unreadable.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { compileLauncherEnvSpec, launcherEnvSpecFilename } from "../launcher/environment.ts";
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

function readArtifact(path: string, expected: string): InstalledArtifact {
  if (!existsSync(path)) {
    return { path, actual: null, expected, unreadable: false };
  }
  try {
    return { path, actual: readFileSync(path, "utf8"), expected, unreadable: false };
  } catch {
    return { path, actual: null, expected, unreadable: true };
  }
}

export interface LauncherDriftOptions {
  readonly root?: string;
  readonly shimSourcePath?: string;
  readonly argv1?: string;
}

/**
 * Gather everything and build the report. Never throws: a fleet that will not resolve becomes a
 * finding, because "your config is broken" is exactly what a doctor should say out loud.
 */
export function collectLauncherDrift(options: LauncherDriftOptions = {}): LauncherDriftReport {
  const root = options.root ?? runtimeRoot();
  const shimSourcePath =
    options.shimSourcePath ?? resolve(import.meta.dir, "../../bin/ccs-claude-shim");
  const deployed = readDeployedRevision(deployedCheckoutPath(options.argv1));

  const config = loadConfig();
  if (!config.ok) {
    return buildLauncherDriftReport({
      deployed,
      artifacts: [],
      missingSpecs: [],
      fleetError: config.error.message,
    });
  }

  const launchers = effectiveLaunchers(config.value);
  if (!launchers.ok) {
    return buildLauncherDriftReport({
      deployed,
      artifacts: [],
      missingSpecs: [],
      fleetError: launchers.error.message,
    });
  }

  const artifacts: InstalledArtifact[] = [];
  const missingSpecs: string[] = [];
  const launcherEnvDir = join(root, "launcher-env");

  // The shim binary itself: the installed copy must be byte-identical to this build's source, or
  // the live critical path is running code nobody is looking at.
  let shimSource: string | null = null;
  try {
    shimSource = readFileSync(shimSourcePath, "utf8");
  } catch {
    shimSource = null;
  }
  if (shimSource !== null) {
    artifacts.push(readArtifact(join(root, "bin", "claude"), shimSource));
  }

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
    const specPath = join(launcherEnvDir, filename.value);
    if (!existsSync(specPath)) {
      missingSpecs.push(launcher.name);
      continue;
    }
    artifacts.push(readArtifact(specPath, spec.value));
  }

  return buildLauncherDriftReport({ deployed, artifacts, missingSpecs, fleetError: null });
}
