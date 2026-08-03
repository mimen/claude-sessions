/**
 * `ccs doctor launcher` — does what is DEPLOYED match what is declared?
 *
 * WHY. Nothing verified that the ccs actually running matched master, or that the installed shim
 * and launcher env-specs matched the config they were generated from. On 2026-07-30 the deployment
 * was three commits behind with a local master 75 behind origin, and no surface said so. Since the
 * launcher indirection now decides which backend EVERY interactive `claude` reaches, a stale
 * deployment or a stale spec is a silent routing fault, not a cosmetic one.
 *
 * REPORT, NEVER REPAIR. Every finding here names a fix the operator runs (`git pull`, `bun link`,
 * `ccs launcher install`). Auto-repair would mean this diagnostic re-deploying a live critical path
 * while the operator is looking at something else — and the honest failure mode of a report is a
 * message that gets ignored, which is strictly better than a surprise redeploy of the shim.
 */
import type { Result } from "../result.ts";

export type LauncherDriftSeverity = "ok" | "warn" | "drift";

export interface LauncherDriftFinding {
  /** Stable machine-readable id, so a caller can act on one finding without parsing prose. */
  readonly check: string;
  readonly severity: LauncherDriftSeverity;
  readonly detail: string;
  /** The exact command that resolves it; null when there is nothing to do. */
  readonly remedy: string | null;
}

export interface LauncherDriftReport {
  readonly findings: readonly LauncherDriftFinding[];
  readonly drifted: number;
  readonly warned: number;
}

/** What the deployed checkout's git state looks like. All fields null when it is not a git repo. */
export interface DeployedRevision {
  /** Absolute path of the deployed checkout (the target of the `ccs` bin link). */
  readonly path: string | null;
  readonly head: string | null;
  /** `origin/<default>` as this checkout last fetched it. */
  readonly originHead: string | null;
  /** Commits HEAD is behind originHead, or null when it cannot be computed. */
  readonly behind: number | null;
  /** Commits HEAD is ahead of originHead. Distinguishes a STALE deployment from an unpushed one. */
  readonly ahead: number | null;
  /** True when the deployed checkout has uncommitted changes. */
  readonly dirty: boolean;
  /** Populated when the revision could not be read at all. */
  readonly error: string | null;
}

/** One installed artifact compared against what the current config would generate. */
export interface InstalledArtifact {
  readonly path: string;
  /** Contents on disk; null when the file is missing or unreadable. */
  readonly actual: string | null;
  /** Contents `ccs launcher install` would write now. */
  readonly expected: string;
  /** Set when the file exists but could not be read (a permissions fault is not "missing"). */
  readonly unreadable: boolean;
}

export interface LauncherDriftInput {
  readonly deployed: DeployedRevision;
  /** The shim binary + one entry per launcher env-spec + the `default` selector file. */
  readonly artifacts: readonly InstalledArtifact[];
  /** Launchers the fleet declares but which have NO spec file at all. */
  readonly missingSpecs: readonly string[];
  /** Set when the fleet itself could not be resolved (bad config or shared registry). */
  readonly fleetError: string | null;
}

const REINSTALL = "ccs launcher install";

/**
 * Fold the gathered facts into findings. PURE — every filesystem and git read happens in the
 * caller, so the decision table is testable without a deployment.
 */
export function buildLauncherDriftReport(input: LauncherDriftInput): LauncherDriftReport {
  const findings: LauncherDriftFinding[] = [];

  if (input.fleetError !== null) {
    // A fleet that will not resolve makes every comparison below meaningless, so say that plainly
    // rather than emitting a cascade of "expected empty" findings.
    findings.push({
      check: "fleet",
      severity: "drift",
      detail: `launcher fleet could not be resolved: ${input.fleetError}`,
      remedy: "fix ~/.ccs/config.toml or the shared launcher registry",
    });
    return summarize(findings);
  }

  findings.push(deployedFinding(input.deployed));

  for (const name of input.missingSpecs) {
    findings.push({
      check: `spec:${name}`,
      severity: "drift",
      detail: `launcher "${name}" is declared but has no environment spec installed — ` +
        "the shim will launch it with the INHERITED environment",
      remedy: REINSTALL,
    });
  }

  for (const artifact of input.artifacts) {
    if (artifact.unreadable) {
      findings.push({
        check: `installed:${artifact.path}`,
        severity: "drift",
        detail: `${artifact.path} exists but could not be read`,
        remedy: REINSTALL,
      });
      continue;
    }
    if (artifact.actual === null) {
      findings.push({
        check: `installed:${artifact.path}`,
        severity: "drift",
        detail: `${artifact.path} is missing`,
        remedy: REINSTALL,
      });
      continue;
    }
    if (artifact.actual !== artifact.expected) {
      findings.push({
        check: `installed:${artifact.path}`,
        severity: "drift",
        detail: `${artifact.path} differs from what the current config would generate`,
        remedy: REINSTALL,
      });
    }
  }

  if (findings.every((finding) => finding.severity === "ok")) {
    findings.push({
      check: "installed",
      severity: "ok",
      detail: "installed shim and launcher env specs match the current config",
      remedy: null,
    });
  }

  return summarize(findings);
}

function deployedFinding(deployed: DeployedRevision): LauncherDriftFinding {
  if (deployed.error !== null) {
    return {
      check: "deployed",
      severity: "warn",
      detail: `deployed revision could not be read: ${deployed.error}`,
      remedy: null,
    };
  }
  if (deployed.path === null) {
    return {
      check: "deployed",
      severity: "warn",
      detail: "the `ccs` on PATH does not resolve to a git checkout — cannot compare it to origin",
      remedy: null,
    };
  }
  if (deployed.head === null || deployed.originHead === null) {
    return {
      check: "deployed",
      severity: "warn",
      detail: `${deployed.path}: no origin default branch to compare against ` +
        "(never fetched, or no remote)",
      remedy: `git -C ${deployed.path} fetch origin`,
    };
  }
  if (deployed.head !== deployed.originHead) {
    // Behind and ahead are different faults. A deployment BEHIND origin is the stale-deploy
    // incident this check exists for. One only AHEAD is a checkout carrying unpushed work — normal
    // in a worktree, and reporting it as a stale deployment to be `pull`ed would be wrong.
    const behind = deployed.behind ?? 0;
    const ahead = deployed.ahead ?? 0;
    const divergence = [
      behind > 0 ? `${behind} behind` : null,
      ahead > 0 ? `${ahead} ahead` : null,
    ].filter((part) => part !== null).join(", ");
    const staleness = behind > 0;
    return {
      check: "deployed",
      severity: staleness ? "drift" : "warn",
      detail: `${deployed.path} is at ${short(deployed.head)}, origin default is ` +
        `${short(deployed.originHead)}${divergence ? ` (${divergence})` : ""}`,
      remedy: staleness ? `git -C ${deployed.path} pull --ff-only` : null,
    };
  }
  if (deployed.dirty) {
    return {
      check: "deployed",
      severity: "warn",
      detail: `${deployed.path} matches origin at ${short(deployed.head)} but has uncommitted changes`,
      remedy: null,
    };
  }
  return {
    check: "deployed",
    severity: "ok",
    detail: `${deployed.path} matches the origin default at ${short(deployed.head)}`,
    remedy: null,
  };
}

function short(revision: string): string {
  return revision.slice(0, 8);
}

function summarize(findings: readonly LauncherDriftFinding[]): LauncherDriftReport {
  return {
    findings,
    drifted: findings.filter((finding) => finding.severity === "drift").length,
    warned: findings.filter((finding) => finding.severity === "warn").length,
  };
}

/** Render the report for a terminal. Kept next to the builder so both stay in step. */
export function renderLauncherDriftReport(report: LauncherDriftReport): string {
  const lines = ["Launcher deployment drift"];
  for (const finding of report.findings) {
    const mark = finding.severity === "ok" ? "ok  " : finding.severity === "warn" ? "warn" : "DRIFT";
    lines.push(`  ${mark.padEnd(5)} ${finding.check.padEnd(28)} ${finding.detail}`);
    if (finding.remedy) lines.push(`        ${" ".repeat(28)} fix: ${finding.remedy}`);
  }
  lines.push(
    report.drifted === 0
      ? `OK — no drift${report.warned > 0 ? ` (${report.warned} warning(s))` : ""}.`
      : `${report.drifted} drift finding(s), ${report.warned} warning(s). Nothing was changed.`,
  );
  return lines.join("\n");
}

/** Exit code contract: drift is a non-zero, actionable result; warnings alone are not. */
export function launcherDriftExitCode(report: LauncherDriftReport): number {
  return report.drifted === 0 ? 0 : 1;
}

export type LauncherDriftResult = Result<LauncherDriftReport>;
