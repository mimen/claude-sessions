import { describe, expect, test } from "bun:test";
import {
  buildLauncherDriftReport,
  launcherDriftExitCode,
  renderLauncherDriftReport,
  type DeployedRevision,
  type LauncherDriftInput,
} from "./launcher-drift.ts";

const MATCHING_DEPLOY: DeployedRevision = {
  path: "/deploy/claude-sessions",
  head: "a".repeat(40),
  originHead: "a".repeat(40),
  behind: 0,
  ahead: 0,
  dirty: false,
  error: null,
};

function input(overrides: Partial<LauncherDriftInput> = {}): LauncherDriftInput {
  return {
    deployed: MATCHING_DEPLOY,
    artifacts: [],
    missingSpecs: [],
    fleetError: null,
    ...overrides,
  };
}

function checks(report: ReturnType<typeof buildLauncherDriftReport>): readonly string[] {
  return report.findings.filter((finding) => finding.severity === "drift").map((f) => f.check);
}

describe("buildLauncherDriftReport", () => {
  test("a matching deployment with matching artifacts is clean", () => {
    const report = buildLauncherDriftReport(
      input({
        artifacts: [
          { path: "/ccs/bin/claude", actual: "shim", expected: "shim", unreadable: false },
        ],
      }),
    );
    expect(report.drifted).toBe(0);
    expect(launcherDriftExitCode(report)).toBe(0);
  });

  /**
   * The exact shape of the incident: the deployment was behind origin and nothing surfaced it.
   */
  test("a deployment behind the ORIGIN default is drift, and says how far behind", () => {
    const report = buildLauncherDriftReport(
      input({
        deployed: {
          ...MATCHING_DEPLOY,
          head: "b".repeat(40),
          originHead: "c".repeat(40),
          behind: 3,
        },
      }),
    );
    expect(checks(report)).toContain("deployed");
    const finding = report.findings.find((f) => f.check === "deployed");
    expect(finding?.detail).toContain("3 behind");
    expect(finding?.remedy).toContain("pull --ff-only");
    expect(launcherDriftExitCode(report)).toBe(1);
  });

  /**
   * A worktree carrying unpushed commits is NOT the stale-deployment incident. Reporting it as
   * drift with a `pull --ff-only` remedy would be actively wrong advice.
   */
  test("a checkout only AHEAD of origin warns, and is not told to pull", () => {
    const report = buildLauncherDriftReport(
      input({
        deployed: {
          ...MATCHING_DEPLOY,
          head: "f".repeat(40),
          originHead: "0".repeat(40),
          behind: 0,
          ahead: 2,
        },
      }),
    );
    const finding = report.findings.find((f) => f.check === "deployed");
    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("2 ahead");
    expect(finding?.remedy).toBeNull();
    expect(launcherDriftExitCode(report)).toBe(0);
  });

  test("a checkout both behind and ahead still counts as a stale deployment", () => {
    const report = buildLauncherDriftReport(
      input({
        deployed: {
          ...MATCHING_DEPLOY,
          head: "f".repeat(40),
          originHead: "0".repeat(40),
          behind: 4,
          ahead: 1,
        },
      }),
    );
    const finding = report.findings.find((f) => f.check === "deployed");
    expect(finding?.severity).toBe("drift");
    expect(finding?.detail).toContain("4 behind, 1 ahead");
  });

  test("an installed artifact that differs from what config would generate is drift", () => {
    const report = buildLauncherDriftReport(
      input({
        artifacts: [
          {
            path: "/ccs/launcher-env/claudex.env",
            actual: "set ANTHROPIC_BASE_URL=http://stale",
            expected: "set ANTHROPIC_BASE_URL=http://127.0.0.1:8317",
            unreadable: false,
          },
        ],
      }),
    );
    expect(checks(report)).toContain("installed:/ccs/launcher-env/claudex.env");
    expect(report.findings.at(-1)?.remedy).toBe("ccs launcher install");
  });

  test("a MISSING launcher env spec is reported — the shim would inherit the environment", () => {
    const report = buildLauncherDriftReport(input({ missingSpecs: ["claude-native"] }));
    expect(checks(report)).toContain("spec:claude-native");
    expect(report.findings[1]?.detail).toContain("INHERITED environment");
  });

  test("an UNREADABLE spec is distinguished from an absent one (ADR-0066)", () => {
    const report = buildLauncherDriftReport(
      input({
        artifacts: [
          { path: "/ccs/launcher-env/x.env", actual: null, expected: "set A=b", unreadable: true },
        ],
      }),
    );
    const finding = report.findings.find((f) => f.check === "installed:/ccs/launcher-env/x.env");
    expect(finding?.detail).toContain("could not be read");
    expect(finding?.detail).not.toContain("is missing");
  });

  test("an unresolvable fleet short-circuits instead of cascading bogus findings", () => {
    const report = buildLauncherDriftReport(
      input({
        fleetError: "duplicate launcher name",
        missingSpecs: ["a", "b", "c"],
      }),
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.check).toBe("fleet");
  });

  test("a dirty-but-current deployment WARNS rather than drifts", () => {
    const report = buildLauncherDriftReport(
      input({ deployed: { ...MATCHING_DEPLOY, dirty: true } }),
    );
    expect(report.drifted).toBe(0);
    expect(report.warned).toBe(1);
    expect(launcherDriftExitCode(report)).toBe(0);
  });

  test("a non-git deployment warns instead of failing the check", () => {
    const report = buildLauncherDriftReport(
      input({ deployed: { ...MATCHING_DEPLOY, path: null, head: null, originHead: null } }),
    );
    expect(report.warned).toBe(1);
    expect(report.drifted).toBe(0);
  });

  test("the report REPORTS — no finding claims anything was changed", () => {
    const report = buildLauncherDriftReport(
      input({
        deployed: { ...MATCHING_DEPLOY, head: "d".repeat(40), originHead: "e".repeat(40), behind: 1 },
        missingSpecs: ["claudex"],
      }),
    );
    const rendered = renderLauncherDriftReport(report);
    expect(rendered).toContain("Nothing was changed.");
    for (const finding of report.findings) {
      if (finding.remedy === null) continue;
      // Remedies are commands for the operator, never something this command ran.
      expect(finding.remedy).toMatch(/^(ccs |git |fix )/);
    }
  });
});
