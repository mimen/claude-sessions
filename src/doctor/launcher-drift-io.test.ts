import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../config.ts";
import { installClaudeShim } from "../launcher/install.ts";
import { collectLauncherDrift } from "./launcher-drift-io.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const value = mkdtempSync(join(tmpdir(), "ccs-launcher-doctor-"));
  roots.push(value);
  return value;
}

function fixtureConfig(fixture: string): Config {
  const path = join(fixture, "config.toml");
  const locations = join(fixture, "locations.toml");
  writeFileSync(
    locations,
    'version = 1\ndefault_host = "host"\ndefault_harness = "claudex"\ndefault_model = "claude-opus-5"\n',
  );
  writeFileSync(
    path,
    [
      '[[launcher]]',
      'name = "claudex"',
      'binary = "claudex"',
      'serves = ["*"]',
      '',
      '[routing]',
      `registry = "${locations}"`,
      `launchers = "${join(fixture, "absent-launchers.toml")}"`,
      '',
    ].join("\n"),
  );
  const loaded = loadConfig(path);
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

describe("launcher drift collection", () => {
  test("reports named wrapper and manifest drift", () => {
    const fixture = fixtureRoot();
    const runtime = join(fixture, "runtime");
    const zshrcPath = join(fixture, ".zshrc");
    const config = fixtureConfig(fixture);
    const installed = installClaudeShim({ root: runtime, zshrcPath, config });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const collect = (overrides: { readonly shimSourcePath?: string } = {}) => collectLauncherDrift({
      root: runtime,
      config,
      zshrcPath,
      argv1: "/missing/ccs",
      ...overrides,
    });

    const clean = collect();
    expect(clean.findings.some((finding) => finding.check.includes("/bin/claudex"))).toBe(false);
    expect(clean.findings.some((finding) => finding.check.includes(".launcher-wrappers"))).toBe(false);

    const defaultPath = join(runtime, "launcher-env", "default");
    writeFileSync(defaultPath, "claude-native\n");
    const defaultDrift = collect();
    expect(defaultDrift.findings.some((finding) =>
      finding.check === `installed:${defaultPath}` && finding.severity === "drift"
    )).toBe(true);
    writeFileSync(defaultPath, "claudex\n");

    const wrapperPath = join(runtime, "bin", "claudex");
    chmodSync(wrapperPath, 0o644);
    const modeDrift = collect();
    expect(modeDrift.findings.some((finding) =>
      finding.check === `installed:${wrapperPath}` && finding.detail.includes("expected 755")
    )).toBe(true);
    chmodSync(wrapperPath, 0o755);

    const staleSpec = join(runtime, "launcher-env", "claude-native.env");
    writeFileSync(staleSpec, "stale spec\n");
    const staleSpecDrift = collect();
    expect(staleSpecDrift.findings.some((finding) => finding.check === `unexpected:${staleSpec}`))
      .toBe(true);
    rmSync(staleSpec);

    const shellInitPath = join(runtime, "shell", "launcher.zsh");
    const shellInit = readFileSync(shellInitPath, "utf8");
    rmSync(shellInitPath);
    const shellDrift = collect();
    expect(shellDrift.findings.some((finding) => finding.check === `installed:${shellInitPath}`))
      .toBe(true);
    writeFileSync(shellInitPath, shellInit);
    chmodSync(shellInitPath, 0o644);

    const zshrc = readFileSync(zshrcPath, "utf8");
    writeFileSync(zshrcPath, "# missing managed block\n");
    const zshrcDrift = collect();
    expect(zshrcDrift.findings.some((finding) => finding.check === `installed:${zshrcPath}`))
      .toBe(true);
    writeFileSync(zshrcPath, zshrc);

    const missingSource = collect({ shimSourcePath: join(fixture, "missing-shim") });
    expect(missingSource.findings.some((finding) =>
      finding.check === "fleet" && finding.detail.includes("cannot read bundled shim source")
    )).toBe(true);

    const unexpectedPath = join(runtime, "bin", "claude-gpt");
    writeFileSync(unexpectedPath, "stale wrapper\n");
    const unexpected = collect();
    expect(unexpected.findings.some((finding) =>
      finding.check === `unexpected:${unexpectedPath}` && finding.severity === "drift"
    )).toBe(true);

    writeFileSync(wrapperPath, `${readFileSync(wrapperPath, "utf8")}# local drift\n`);
    const wrapperDrift = collect();
    expect(wrapperDrift.findings.some((finding) =>
      finding.check === `installed:${wrapperPath}` && finding.severity === "drift"
    )).toBe(true);

    writeFileSync(join(runtime, "bin", ".launcher-wrappers"), "claude-native\n");
    const manifestDrift = collect();
    expect(manifestDrift.findings.some((finding) =>
      finding.check.endsWith("/.launcher-wrappers") && finding.severity === "drift"
    )).toBe(true);
  });

  test("accepts and preserves a zshrc symlink while checking its target contents", () => {
    const fixture = fixtureRoot();
    const runtime = join(fixture, "runtime");
    const target = join(fixture, "dotfiles-zshrc");
    const zshrcPath = join(fixture, ".zshrc");
    writeFileSync(target, "export EXISTING=1\n");
    symlinkSync(target, zshrcPath);
    const config = fixtureConfig(fixture);

    const installed = installClaudeShim({ root: runtime, zshrcPath, config });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(lstatSync(zshrcPath).isSymbolicLink()).toBe(true);

    const report = collectLauncherDrift({
      root: runtime,
      config,
      zshrcPath,
      argv1: "/missing/ccs",
    });
    expect(report.findings.some((finding) => finding.check === `installed:${zshrcPath}`)).toBe(false);
  });
});
