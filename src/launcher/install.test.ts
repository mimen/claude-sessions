import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  const routing: string[] = [];
  if (!toml.includes("registry =")) routing.push(`registry = "${join(fixture, "absent-locations.toml")}"`);
  if (!toml.includes("launchers =")) routing.push(`launchers = "${join(fixture, "absent-launchers.toml")}"`);
  const content = toml.includes("[routing]")
    ? toml.replace("[routing]", `[routing]\n${routing.join("\n")}`)
    : `${toml}\n[routing]\n${routing.join("\n")}\n`;
  writeFileSync(path, content);
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
clears = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
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
  test("installs configured bundled wrappers beside the PATH-precedent shim", () => {
    const fixture = root();
    const source = join(fixture, "source-shim");
    const wrapperSourceDir = join(fixture, "wrappers");
    const runtime = join(fixture, "runtime");
    writeFileSync(source, "#!/bin/sh\nexit 0\n");
    mkdirSync(wrapperSourceDir);
    writeFileSync(join(wrapperSourceDir, "claudex"), "#!/bin/sh\nexport CCS_FORCE_HARNESS=claudex\nexit 0\n");
    writeFileSync(join(wrapperSourceDir, "claude-native"), "#!/bin/sh\nexport CCS_FORCE_HARNESS=claude-native\nexit 0\n");
    writeFileSync(join(wrapperSourceDir, "claude-gpt"), "#!/bin/sh\nexport CCS_FORCE_HARNESS=claude-gpt\nexit 0\n");

    const first = installClaudeShim({
      sourcePath: source,
      wrapperSourceDir,
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(fixture, FLEET_TOML),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.wrappers).toEqual(["claude-native", "claudex"]);
    expect(statSync(join(runtime, "bin", "claudex")).mode & 0o111).not.toBe(0);
    expect(statSync(join(runtime, "bin", "claude-native")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(runtime, "bin", "claude-gpt"))).toBe(false);

    const second = installClaudeShim({
      sourcePath: source,
      wrapperSourceDir,
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(fixture, '[[launcher]]\nname = "claudex"\nbinary = "claudex"\nserves = ["*"]\n'),
    });
    expect(second.ok).toBe(true);
    expect(existsSync(join(runtime, "bin", "claude-native"))).toBe(false);
  });

  test("uses launcher.binary for the installed command and rewrites its selector", () => {
    const fixture = root();
    const source = join(fixture, "source-shim");
    const wrapperSourceDir = join(fixture, "wrappers");
    const runtime = join(fixture, "runtime");
    writeFileSync(source, "#!/bin/sh\nexit 0\n");
    mkdirSync(wrapperSourceDir);
    writeFileSync(
      join(wrapperSourceDir, "claude-native"),
      "#!/bin/sh\nexport CCS_FORCE_HARNESS=claude-native\nexit 0\n",
    );

    const result = installClaudeShim({
      sourcePath: source,
      wrapperSourceDir,
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(
        fixture,
        `[[launcher]]\nname = "native"\nbinary = "${join(runtime, "bin", "claude-native")}"\nserves = ["claude-*"]\n`,
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wrappers).toEqual(["claude-native"]);
    expect(readFileSync(join(runtime, "bin", "claude-native"), "utf8"))
      .toContain("export CCS_FORCE_HARNESS=native");
  });

  test("refuses to overwrite unowned wrapper files or follow destination symlinks", () => {
    for (const kind of ["file", "symlink"] as const) {
      const fixture = root();
      const source = join(fixture, "source-shim");
      const wrapperSourceDir = join(fixture, "wrappers");
      const runtime = join(fixture, "runtime");
      const bin = join(runtime, "bin");
      const destination = join(bin, "claudex");
      const external = join(fixture, "external");
      writeFileSync(source, "#!/bin/sh\nexit 0\n");
      mkdirSync(wrapperSourceDir);
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(wrapperSourceDir, "claudex"),
        "#!/bin/sh\nexport CCS_FORCE_HARNESS=claudex\nexit 0\n",
      );
      writeFileSync(external, "external-sentinel\n");
      if (kind === "file") writeFileSync(destination, "custom-sentinel\n");
      else symlinkSync(external, destination);

      const result = installClaudeShim({
        sourcePath: source,
        wrapperSourceDir,
        root: runtime,
        zshrcPath: join(fixture, ".zshrc"),
        config: config(fixture, '[[launcher]]\nname = "claudex"\nbinary = "claudex"\nserves = ["*"]\n'),
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.message).toContain("refusing to overwrite unowned launcher wrapper");
      expect(readFileSync(external, "utf8")).toBe("external-sentinel\n");
      expect(existsSync(join(runtime, "launcher-env"))).toBe(false);
    }
  });

  test("refuses symlinked managed directories before touching their targets", () => {
    const fixture = root();
    const runtime = join(fixture, "runtime");
    const external = join(fixture, "external-env");
    mkdirSync(runtime);
    mkdirSync(external);
    writeFileSync(join(external, "sentinel"), "keep\n");
    symlinkSync(external, join(runtime, "launcher-env"));

    const result = install(fixture, FLEET_TOML);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("managed launcher path is not a real directory");
    expect(readFileSync(join(external, "sentinel"), "utf8")).toBe("keep\n");
  });

  test("serializes launcher installations with a live process lock", () => {
    const fixture = root();
    const runtime = join(fixture, "runtime");
    mkdirSync(runtime);
    writeFileSync(join(runtime, "launcher-install.lock"), `${process.pid}\n`);

    const result = install(fixture, FLEET_TOML);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("another launcher installation holds");
    expect(existsSync(join(runtime, "bin"))).toBe(false);
  });

  test("fails before runtime mutation when zshrc exists but cannot be read", () => {
    const fixture = root();
    const source = join(fixture, "source-shim");
    const runtime = join(fixture, "runtime");
    const zshrc = join(fixture, ".zshrc");
    writeFileSync(source, "#!/bin/sh\nexit 0\n");
    writeFileSync(zshrc, "preserve me\n");
    chmodSync(zshrc, 0o200);

    const result = installClaudeShim({
      sourcePath: source,
      root: runtime,
      zshrcPath: zshrc,
      config: config(fixture, FLEET_TOML),
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(runtime, "bin"))).toBe(false);
  });

  test("prevalidates stale wrapper removal before publishing a new generation", () => {
    const fixture = root();
    const source = join(fixture, "source-shim");
    const wrapperSourceDir = join(fixture, "wrappers");
    const runtime = join(fixture, "runtime");
    writeFileSync(source, "#!/bin/sh\nexit 0\n");
    mkdirSync(wrapperSourceDir);
    writeFileSync(join(wrapperSourceDir, "claudex"), "#!/bin/sh\nexport CCS_FORCE_HARNESS=claudex\n");
    writeFileSync(
      join(wrapperSourceDir, "claude-native"),
      "#!/bin/sh\nexport CCS_FORCE_HARNESS=claude-native\n",
    );
    const first = installClaudeShim({
      sourcePath: source,
      wrapperSourceDir,
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(fixture, FLEET_TOML),
    });
    expect(first.ok).toBe(true);
    const claudexPath = join(runtime, "bin", "claudex");
    const before = readFileSync(claudexPath, "utf8");
    const stalePath = join(runtime, "bin", "claude-native");
    rmSync(stalePath);
    mkdirSync(stalePath);

    const second = installClaudeShim({
      sourcePath: source,
      wrapperSourceDir,
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(fixture, '[[launcher]]\nname = "claudex"\nbinary = "claudex"\nserves = ["*"]\n'),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.message).toContain("stale managed launcher wrapper is not removable");
    expect(readFileSync(claudexPath, "utf8")).toBe(before);
  });

  test("validates all environment specs before changing installed wrappers", () => {
    const fixture = root();
    const source = join(fixture, "source-shim");
    const wrapperSourceDir = join(fixture, "wrappers");
    const runtime = join(fixture, "runtime");
    const wrapperSource = join(wrapperSourceDir, "claudex");
    writeFileSync(source, "#!/bin/sh\nexit 0\n");
    mkdirSync(wrapperSourceDir);
    writeFileSync(wrapperSource, "#!/bin/sh\nexport CCS_FORCE_HARNESS=claudex\nexit 0\n");

    const first = installClaudeShim({
      sourcePath: source,
      wrapperSourceDir,
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(fixture, '[[launcher]]\nname = "claudex"\nbinary = "claudex"\nserves = ["*"]\n'),
    });
    expect(first.ok).toBe(true);
    const installedPath = join(runtime, "bin", "claudex");
    const manifestPath = join(runtime, "bin", ".launcher-wrappers");
    const beforeWrapper = readFileSync(installedPath, "utf8");
    const beforeManifest = readFileSync(manifestPath, "utf8");
    writeFileSync(wrapperSource, `${beforeWrapper}# changed source\n`);

    const second = installClaudeShim({
      sourcePath: source,
      wrapperSourceDir,
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(
        fixture,
        '[[launcher]]\nname = "claudex"\nbinary = "claudex"\nserves = ["*"]\nenv = { "BAD-KEY" = "x" }\n',
      ),
    });
    expect(second.ok).toBe(false);
    expect(readFileSync(installedPath, "utf8")).toBe(beforeWrapper);
    expect(readFileSync(manifestPath, "utf8")).toBe(beforeManifest);
  });

  test("a missing configured bundled source preserves the installed wrapper", () => {
    const fixture = root();
    const source = join(fixture, "source-shim");
    const wrapperSourceDir = join(fixture, "wrappers");
    const runtime = join(fixture, "runtime");
    const wrapperSource = join(wrapperSourceDir, "claudex");
    writeFileSync(source, "#!/bin/sh\nexit 0\n");
    mkdirSync(wrapperSourceDir);
    writeFileSync(wrapperSource, "#!/bin/sh\nexport CCS_FORCE_HARNESS=claudex\nexit 0\n");
    const fleet = '[[launcher]]\nname = "claudex"\nbinary = "claudex"\nserves = ["*"]\n';

    const first = installClaudeShim({
      sourcePath: source,
      wrapperSourceDir,
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(fixture, fleet),
    });
    expect(first.ok).toBe(true);
    const installedPath = join(runtime, "bin", "claudex");
    const manifestPath = join(runtime, "bin", ".launcher-wrappers");
    const beforeWrapper = readFileSync(installedPath, "utf8");
    const beforeManifest = readFileSync(manifestPath, "utf8");
    rmSync(wrapperSource);

    const second = installClaudeShim({
      sourcePath: source,
      wrapperSourceDir,
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(fixture, fleet),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.message).toContain("configured bundled launcher wrapper is missing");
    expect(readFileSync(installedPath, "utf8")).toBe(beforeWrapper);
    expect(readFileSync(manifestPath, "utf8")).toBe(beforeManifest);
  });

  test("rejects manifest entries that could target non-wrapper runtime files", () => {
    const fixture = root();
    const source = join(fixture, "source-shim");
    const wrapperSourceDir = join(fixture, "wrappers");
    const runtime = join(fixture, "runtime");
    writeFileSync(source, "#!/bin/sh\nexit 0\n");
    mkdirSync(wrapperSourceDir);
    writeFileSync(
      join(wrapperSourceDir, "claudex"),
      "#!/bin/sh\nexport CCS_FORCE_HARNESS=claudex\nexit 0\n",
    );
    const fleet = '[[launcher]]\nname = "claudex"\nbinary = "claudex"\nserves = ["*"]\n';
    const first = installClaudeShim({
      sourcePath: source,
      wrapperSourceDir,
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(fixture, fleet),
    });
    expect(first.ok).toBe(true);
    const shimPath = join(runtime, "bin", "claude");
    const beforeShim = readFileSync(shimPath, "utf8");
    writeFileSync(join(runtime, "bin", ".launcher-wrappers"), "claude\n");

    const second = installClaudeShim({
      sourcePath: source,
      wrapperSourceDir,
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(fixture, fleet),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.message).toContain("manifest contains an unknown binary");
    expect(readFileSync(shimPath, "utf8")).toBe(beforeShim);
  });

  test("installed wrappers name themselves and the shim isolates each launcher environment", () => {
    const fixture = root();
    const runtime = join(fixture, "runtime");
    const key = join(fixture, "gateway-key");
    const rawClaude = join(fixture, "raw-claude");
    writeFileSync(key, "test-gateway-token\n");
    writeFileSync(
      rawClaude,
      [
        "#!/bin/sh",
        "printf 'base=%s\\nauth=%s\\napi=%s\\nforce=%s\\nargs=%s\\n' \\",
        "  \"${ANTHROPIC_BASE_URL-}\" \"${ANTHROPIC_AUTH_TOKEN-}\" \"${ANTHROPIC_API_KEY-}\" \\",
        "  \"${CCS_FORCE_HARNESS-}\" \"$*\"",
        "",
      ].join("\n"),
    );
    chmodSync(rawClaude, 0o755);

    const fleet = `${FLEET_TOML.replace("/tmp/key", key)}
[[launcher]]
name = "claude-gpt"
binary = "claude-gpt"
serves = ["gpt-*"]
env = { ANTHROPIC_BASE_URL = "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN = "@file:${key}" }
`;
    const installed = installClaudeShim({
      root: runtime,
      zshrcPath: join(fixture, ".zshrc"),
      config: config(fixture, fleet),
    });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(installed.value.wrappers).toEqual(["claude-gpt", "claude-native", "claudex"]);

    for (const name of installed.value.wrappers) {
      const wrapper = readFileSync(join(runtime, "bin", name), "utf8");
      expect(wrapper).toStartWith("#!/bin/zsh -f\n");
      expect(wrapper).toContain(`export CCS_FORCE_HARNESS=${name}`);
    }

    const run = (name: string): string => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: "/usr/bin:/bin",
        CCS_RAW_CLAUDE_PATH: rawClaude,
        CCS_LAUNCHER_ENV_DIR: installed.value.launcherEnvDir,
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
        ANTHROPIC_BASE_URL: "http://wrong-gateway",
        ANTHROPIC_AUTH_TOKEN: "wrong-token",
        ANTHROPIC_API_KEY: "wrong-api-key",
      };
      delete env.CMUX_SURFACE_ID;
      delete env.CCS_CLAUDE_SHIM_AFTER_CMUX;
      delete env.CCS_CARRIED_ANTHROPIC_API_KEY;
      delete env.CCS_CARRIED_ANTHROPIC_BASE_URL;
      const result = Bun.spawnSync([join(runtime, "bin", name), "--version"], { env });
      expect(result.exitCode).toBe(0);
      return new TextDecoder().decode(result.stdout);
    };

    const native = run("claude-native");
    expect(native).toContain("base=\nauth=\napi=\nforce=\n");
    expect(native).toContain("args=--version");

    const mixed = run("claudex");
    expect(mixed).toContain("base=http://127.0.0.1:8317");
    expect(mixed).toContain("auth=test-gateway-token");
    expect(mixed).toContain("force=\n");
    expect(mixed).toContain("args=--dangerously-skip-permissions --model opus --version");

    const gpt = run("claude-gpt");
    expect(gpt).toContain("base=http://127.0.0.1:8317");
    expect(gpt).toContain("auth=test-gateway-token");
    expect(gpt).toContain("force=\n");
    expect(gpt).toContain("args=--dangerously-skip-permissions --model fable --version");
  });

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
    expect(result.error.message).toContain('default_harness "claude-gpt" has no launcher entry');
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
