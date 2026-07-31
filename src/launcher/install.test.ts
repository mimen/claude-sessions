import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeShim, updateZshrc } from "./install.ts";
import { loadConfig } from "../config.ts";
import type { Config } from "../config.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ccs-shim-install-"));
  roots.push(value);
  return value;
}

/**
 * Build a Config from TOML text on disk. Every installClaudeShim call in this file passes one
 * explicitly, so the suite never reads (or is perturbed by) the real ~/.ccs/config.toml.
 *
 * `[routing].registry` is pinned into the fixture unless the TOML sets it: an unset registry
 * resolves to the REAL ~/.ccs/locations.toml, which would make these assertions depend on the
 * host's actual default_harness.
 */
function config(fixture: string, toml: string): Config {
  const path = join(fixture, "config.toml");
  const registryPinned = toml.includes("registry =");
  writeFileSync(
    path,
    registryPinned ? toml : `${toml}\n[routing]\nregistry = "${join(fixture, "absent.toml")}"\n`,
  );
  const loaded = loadConfig(path);
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

const EMPTY_CONFIG = (fixture: string): Config => config(fixture, "");

describe("Claude shim installation", () => {
  test("installs the executable, shell init, and idempotent zshrc block", () => {
    const fixture = root();
    const source = join(fixture, "source-shim");
    const runtime = join(fixture, "runtime");
    const zshrc = join(fixture, ".zshrc");
    writeFileSync(source, "#!/bin/sh\nexit 0\n");
    writeFileSync(zshrc, "export EXISTING=1\n");

    const first = installClaudeShim({ sourcePath: source, root: runtime, zshrcPath: zshrc, config: EMPTY_CONFIG(fixture) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(existsSync(first.value.shimPath)).toBe(true);
    expect(statSync(first.value.shimPath).mode & 0o111).not.toBe(0);
    expect(readFileSync(first.value.shellInitPath, "utf8")).toContain("CMUX_CUSTOM_CLAUDE_PATH");
    expect(readFileSync(zshrc, "utf8")).toContain("# >>> CCS managed Claude launcher >>>");

    const cmuxProbe = Bun.spawnSync([
      "zsh",
      "-fc",
      `export PATH='/usr/bin:/tmp/cmux-cli-shims/surface:/usr/local/bin'; source ${JSON.stringify(first.value.shellInitPath)}; print -r -- "$PATH"`,
    ]);
    expect(cmuxProbe.exitCode).toBe(0);
    expect(new TextDecoder().decode(cmuxProbe.stdout).trim().split(":").slice(0, 3)).toEqual([
      join(runtime, "bin"),
      "/usr/bin",
      "/tmp/cmux-cli-shims/surface",
    ]);

    const plainProbe = Bun.spawnSync([
      "zsh",
      "-fc",
      `export PATH='/usr/bin:/usr/local/bin'; source ${JSON.stringify(first.value.shellInitPath)}; print -r -- "$PATH"`,
    ]);
    expect(plainProbe.exitCode).toBe(0);
    expect(new TextDecoder().decode(plainProbe.stdout).trim().split(":").slice(0, 2)).toEqual([
      join(runtime, "bin"),
      "/usr/bin",
    ]);

    const second = installClaudeShim({ sourcePath: source, root: runtime, zshrcPath: zshrc, config: EMPTY_CONFIG(fixture) });
    expect(second.ok).toBe(true);
    expect(readFileSync(zshrc, "utf8").match(/CCS managed Claude launcher >>>/g)).toHaveLength(1);
  });

  test("replaces an existing managed block without touching surrounding config", () => {
    const updated = updateZshrc(
      "before\n# >>> CCS managed Claude launcher >>>\nold\n# <<< CCS managed Claude launcher <<<\nafter\n",
      "/new/launcher.zsh",
    );
    expect(updated).toStartWith("before\n");
    expect(updated).toContain("/new/launcher.zsh");
    expect(updated).toEndWith("\nafter\n");
    expect(updated).not.toContain("\nold\n");
  });
});

const FLEET_TOML = `
[[launcher]]
name = "claudex"
binary = "claudex"
serves = ["*"]
env = { ANTHROPIC_BASE_URL = "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN = "@file:/tmp/key" }

[[launcher]]
name = "claude-native"
binary = "claude-native"
serves = ["claude-*"]
clears = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
`;

function install(fixture: string, toml: string): ReturnType<typeof installClaudeShim> {
  const source = join(fixture, "source-shim");
  writeFileSync(source, "#!/bin/sh\nexit 0\n");
  return installClaudeShim({
    sourcePath: source,
    root: join(fixture, "runtime"),
    zshrcPath: join(fixture, ".zshrc"),
    config: config(fixture, toml),
  });
}

describe("launcher environment materialization", () => {
  test("writes one spec per configured launcher", () => {
    const fixture = root();
    const result = install(fixture, FLEET_TOML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.launchers).toEqual(["claudex", "claude-native"]);
    const claudex = readFileSync(join(result.value.launcherEnvDir, "claudex.env"), "utf8");
    expect(claudex).toContain("set ANTHROPIC_BASE_URL=http://127.0.0.1:8317");
    // The secret is REFERENCED, never copied: the spec holds the path, not the credential.
    expect(claudex).toContain("setfile ANTHROPIC_AUTH_TOKEN=/tmp/key");

    const native = readFileSync(join(result.value.launcherEnvDir, "claude-native.env"), "utf8");
    expect(native).toContain("clear ANTHROPIC_BASE_URL");
    expect(native).toContain("clear ANTHROPIC_AUTH_TOKEN");
    expect(native).not.toContain("set ANTHROPIC_BASE_URL");
  });

  test("the default launcher comes from the location registry's default_harness", () => {
    const fixture = root();
    const registry = join(fixture, "locations.toml");
    writeFileSync(
      registry,
      'version = 1\ndefault_host = "h"\ndefault_harness = "claudex"\ndefault_model = "claude-opus-5"\n',
    );

    const result = install(fixture, `${FLEET_TOML}\n[routing]\nregistry = "${registry}"\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLauncher).toBe("claudex");
    expect(readFileSync(join(result.value.launcherEnvDir, "default"), "utf8").trim()).toBe("claudex");
  });

  test("repointing default_harness is the ONE edit that moves interactive `claude`", () => {
    const fixture = root();
    const registry = join(fixture, "locations.toml");
    const configToml = `${FLEET_TOML}\n[routing]\nregistry = "${registry}"\n`;

    writeFileSync(
      registry,
      'version = 1\ndefault_host = "h"\ndefault_harness = "claudex"\ndefault_model = "claude-opus-5"\n',
    );
    const before = install(fixture, configToml);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(readFileSync(join(before.value.launcherEnvDir, "default"), "utf8").trim()).toBe("claudex");

    writeFileSync(
      registry,
      'version = 1\ndefault_host = "h"\ndefault_harness = "claude-native"\ndefault_model = "claude-opus-5"\n',
    );
    const after = install(fixture, configToml);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.defaultLauncher).toBe("claude-native");
    expect(readFileSync(join(after.value.launcherEnvDir, "default"), "utf8").trim()).toBe("claude-native");
  });

  test("a default_harness with no [[launcher]] entry fails loudly", () => {
    const fixture = root();
    const registry = join(fixture, "locations.toml");
    writeFileSync(
      registry,
      'version = 1\ndefault_host = "h"\ndefault_harness = "claude-gpt"\ndefault_model = "gpt-5.6-sol"\n',
    );

    const result = install(fixture, `${FLEET_TOML}\n[routing]\nregistry = "${registry}"\n`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('default_harness "claude-gpt" has no [[launcher]] entry');
  });

  test("an absent registry means no default — the raw binary keeps today's behavior", () => {
    const fixture = root();
    const result = install(fixture, FLEET_TOML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLauncher).toBeNull();
    expect(existsSync(join(result.value.launcherEnvDir, "default"))).toBe(false);
  });

  test("an undeclared fleet installs cleanly and materializes no default", () => {
    const fixture = root();
    const registry = join(fixture, "locations.toml");
    // A host with a registry that names a harness but NO [[launcher]] entries: the feature is
    // invisible until the fleet is configured, so this must install rather than refuse.
    writeFileSync(
      registry,
      'version = 1\ndefault_host = "h"\ndefault_harness = "claudex"\ndefault_model = "claude-opus-5"\n',
    );

    const result = install(fixture, `[routing]\nregistry = "${registry}"\n`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defaultLauncher).toBeNull();
    expect(existsSync(join(result.value.launcherEnvDir, "default"))).toBe(false);
  });

  test("a launcher removed from config stops resolving", () => {
    const fixture = root();
    const first = install(fixture, FLEET_TOML);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(existsSync(join(first.value.launcherEnvDir, "claude-native.env"))).toBe(true);

    const second = install(
      fixture,
      '[[launcher]]\nname = "claudex"\nbinary = "claudex"\nserves = ["*"]\n',
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(existsSync(join(second.value.launcherEnvDir, "claudex.env"))).toBe(true);
    expect(existsSync(join(second.value.launcherEnvDir, "claude-native.env"))).toBe(false);
  });
});
