import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeShim, updateZshrc } from "./install.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ccs-shim-install-"));
  roots.push(value);
  return value;
}

describe("Claude shim installation", () => {
  test("installs the executable, shell init, and idempotent zshrc block", () => {
    const fixture = root();
    const source = join(fixture, "source-shim");
    const runtime = join(fixture, "runtime");
    const zshrc = join(fixture, ".zshrc");
    writeFileSync(source, "#!/bin/sh\nexit 0\n");
    writeFileSync(zshrc, "export EXISTING=1\n");

    const first = installClaudeShim({ sourcePath: source, root: runtime, zshrcPath: zshrc });
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

    const second = installClaudeShim({ sourcePath: source, root: runtime, zshrcPath: zshrc });
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
