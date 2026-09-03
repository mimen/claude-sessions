import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectModelDeclarations } from "./model-declarations-io.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly settingsPath: string;
  readonly agentsRoot: string;
  readonly configPath: string;
  readonly launcherRegistryPath: string;
  readonly locationRegistryPath: string;
}

interface FixtureOptions {
  readonly drift?: boolean;
  readonly malformedSettings?: boolean;
  readonly omitAvailableModels?: boolean;
  readonly mappedGptPicker?: boolean;
  readonly environmentDrift?: boolean;
  readonly localLauncherDrift?: boolean;
  readonly missingSharedLaunchers?: boolean;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ccs-model-doctor-"));
  roots.push(root);
  const agentsRoot = join(root, "agents");
  mkdirSync(agentsRoot);
  const settingsPath = join(root, "settings.json");
  const configPath = join(root, "config.toml");
  const launcherRegistryPath = join(root, "launchers.toml");
  const locationRegistryPath = join(root, "locations.toml");
  const fableDirect = options.drift ? "claude-fable-5" : "claude-fable-5-1[1m]";
  const opusDirect = options.drift ? "claude-opus-5" : "claude-opus-5[1m]";
  const fableCanonical = options.drift ? "claude-fable-5" : "claude-fable-5-1";
  const availableModels = [fableDirect, opusDirect, "claude-haiku-4-5", "gpt-5.6-sol"];
  const pickerOptions: Array<{ model: string; behavesAs?: string }> = [
    { model: fableDirect },
    { model: opusDirect },
    {
      model: "gpt-5.6-sol",
      ...(options.mappedGptPicker ? { behavesAs: "claude-sonnet-5" } : {}),
    },
  ];
  const environment = options.environmentDrift
    ? {
        ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-opus-5",
        ANTHROPIC_DEFAULT_MODEL: "claude-opus-5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
        ANTHROPIC_MODEL: "claude-fable-5",
        ANTHROPIC_SMALL_FAST_MODEL: "claude-opus-5",
        CLAUDE_CODE_AUTO_MODE_MODEL: "claude-opus-5",
        CLAUDE_CODE_BG_CLASSIFIER_MODEL: "claude-opus-5",
        CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5",
      }
    : { CLAUDE_CODE_SUBAGENT_MODEL: "gpt-5.6-luna(xhigh)" };
  const settings = {
    model: fableDirect,
    ...(!options.omitAvailableModels ? { availableModels } : {}),
    modelPicker: { options: pickerOptions },
    env: environment,
  };

  writeFileSync(settingsPath, options.malformedSettings ? "{" : JSON.stringify(settings));
  writeFileSync(
    join(agentsRoot, "reviewer.md"),
    `---\nname: reviewer\nmodel: ${opusDirect}\nfallback_model: ${fableDirect}\n---\nReview.\n`,
  );
  if (!options.missingSharedLaunchers) {
    writeFileSync(
      launcherRegistryPath,
      `version = 1\n\n[[launcher]]\nname = "claudex"\nbinary = "claudex"\nserves = ["*"]\n\n[launcher.env]\nANTHROPIC_DEFAULT_FABLE_MODEL = "${fableDirect}"\nANTHROPIC_DEFAULT_OPUS_MODEL = "${opusDirect}"\nANTHROPIC_DEFAULT_HAIKU_MODEL = "gpt-5.6-luna(low)"\n${options.environmentDrift ? "ANTHROPIC_MODEL = \"claude-sonnet-5\"\nCLAUDE_CODE_SUBAGENT_MODEL = \"claude-opus-5\"\n" : ""}`,
    );
  }
  writeFileSync(
    locationRegistryPath,
    `version = 1\ndefault_host = "host"\ndefault_harness = "claudex"\ndefault_model = "claude-opus-5"\n\n[[location]]\nkey = "app"\nname = "App"\ncwd = "/tmp/app"\nkind = "repo"\neligible_hosts = ["host"]\npreferred_host = "host"\ndefault_harness = "claudex"\ndefault_model = "${fableCanonical}"\nstatus = "active"\n`,
  );
  const localLauncher = options.localLauncherDrift || options.missingSharedLaunchers
    ? `\n[[launcher]]\nname = "claudex"\nbinary = "claudex"\nserves = ["*"]\n\n[launcher.env]\nANTHROPIC_DEFAULT_OPUS_MODEL = "${options.localLauncherDrift ? "claude-opus-5" : "claude-opus-5[1m]"}"\n`
    : "";
  writeFileSync(
    configPath,
    `[host]\nlabel = "test"\n\n[routing]\nlaunchers = "${launcherRegistryPath}"\nregistry = "${locationRegistryPath}"\n${localLauncher}`,
  );

  return { settingsPath, agentsRoot, configPath, launcherRegistryPath, locationRegistryPath };
}

function collect(fixturePaths: Fixture) {
  return collectModelDeclarations({
    settingsPath: fixturePaths.settingsPath,
    agentsRoot: fixturePaths.agentsRoot,
    configPath: fixturePaths.configPath,
  });
}

describe("model declaration collection", () => {
  test("collects configured settings, Agent, launcher, and routing paths without drift", () => {
    const paths = fixture();
    const result = collect(paths);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toEqual([]);
  });

  test("finds bare direct Claude IDs and stale Fable 5 declarations on every surface", () => {
    const result = collect(fixture({ drift: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const checks = result.value.findings.map((finding) => finding.check);
    expect(checks).toContain("settings.model");
    expect(checks).toContain("settings.availableModels");
    expect(checks).toContain("settings.modelPicker");
    expect(checks).toContain("agent.model");
    expect(checks).toContain("agent.fallback_model");
    expect(checks).toContain("launcher.slot");
    expect(checks).toContain("routing.default_model");
  });

  test("collects model selectors from settings and launcher environments", () => {
    const result = collect(fixture({ environmentDrift: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const checks = result.value.findings.map((finding) => finding.check);
    const fields = result.value.findings.map((finding) => finding.field);
    expect(checks).toContain("settings.environment");
    expect(checks).toContain("settings.subagentModel");
    expect(checks).toContain("launcher.environment");
    for (const key of [
      "ANTHROPIC_CUSTOM_MODEL_OPTION",
      "ANTHROPIC_DEFAULT_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_AUTO_MODE_MODEL",
      "CLAUDE_CODE_BG_CLASSIFIER_MODEL",
    ]) {
      expect(fields).toContain(`env.${key}`);
    }
  });

  test("checks the effective machine-local launcher override", () => {
    const paths = fixture({ localLauncherDrift: true });
    const result = collect(paths);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toContainEqual(expect.objectContaining({
      check: "launcher.slot",
      path: paths.configPath,
      actual: "claude-opus-5",
    }));
  });

  test("accepts a machine-only launcher fleet when the shared registry is absent", () => {
    const result = collect(fixture({ missingSharedLaunchers: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toEqual([]);
  });

  test("does not invent an allowlist when availableModels is omitted", () => {
    const result = collect(fixture({ omitAvailableModels: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toEqual([]);
  });

  test("finds GPT-5.6 picker mappings that clamp the launcher context to 200K", () => {
    const result = collect(fixture({ mappedGptPicker: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toContainEqual(expect.objectContaining({
      check: "settings.modelPicker.behavesAs",
      actual: "claude-sonnet-5",
    }));
  });

  test("uses CLAUDE_CONFIG_DIR and CCS_AGENTS_ROOT for live declaration paths", () => {
    const paths = fixture();
    const result = collectModelDeclarations({
      configPath: paths.configPath,
      environment: {
        HOME: "/unused",
        CLAUDE_CONFIG_DIR: dirname(paths.settingsPath),
        CCS_AGENTS_ROOT: paths.agentsRoot,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toEqual([]);
  });

  test("returns malformed required input as an operational error", () => {
    const result = collect(fixture({ malformedSettings: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("failed to read Claude Code settings");
  });
});
