import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WRAPPER_SOURCE = resolve(import.meta.dir, "../../bin/wrappers");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Observation {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runWrapper(binary: string, args: readonly string[]): Observation {
  const root = mkdtempSync(join(tmpdir(), "ccs-context-wrapper-"));
  roots.push(root);
  const wrapper = join(root, binary);
  copyFileSync(join(WRAPPER_SOURCE, binary), wrapper);
  writeFileSync(
    join(root, "claude"),
    "#!/bin/sh\nprintf 'selector=%s\\n' \"$CCS_FORCE_HARNESS\"\nfor arg in \"$@\"; do printf 'arg=%s\\n' \"$arg\"; done\n",
  );
  chmodSync(wrapper, 0o755);
  chmodSync(join(root, "claude"), 0o755);

  const result = Bun.spawnSync([wrapper, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("context-family launcher wrappers", () => {
  test("claudex declares 1M only for Claude and preserves GPT-5.6 at 921K", () => {
    const claude = runWrapper("claudex", ["claude-opus-5", "-p", "hello"]);
    expect(claude.exitCode).toBe(0);
    expect(claude.stdout).toContain("selector=claudex");
    expect(claude.stdout).toContain("arg=claude-opus-5[1m]");

    const gpt = runWrapper("claudex", ["--model=gpt-5.6-sol[1m]", "-p", "hello"]);
    expect(gpt.exitCode).toBe(0);
    expect(gpt.stdout).toContain("arg=--model=gpt-5.6-sol");
    expect(gpt.stdout).not.toContain("[1m]");
  });

  test("claudex refuses models that need a smaller process envelope", () => {
    const gpt55 = runWrapper("claudex", ["gpt-5.5"]);
    expect(gpt55.exitCode).toBe(2);
    expect(gpt55.stderr).toContain("claude-gpt55");

    const qwen = runWrapper("claudex", ["--model", "qwen3.8-local"]);
    expect(qwen.exitCode).toBe(2);
    expect(qwen.stderr).toContain("local-mlx");
  });

  test("claude-gpt strips obsolete 1M markers and refuses GPT-5.5", () => {
    const gpt56 = runWrapper("claude-gpt", ["gpt-5.6-terra[1m]"]);
    expect(gpt56.exitCode).toBe(0);
    expect(gpt56.stdout).toContain("selector=claude-gpt");
    expect(gpt56.stdout).toContain("arg=gpt-5.6-terra");
    expect(gpt56.stdout).not.toContain("[1m]");

    const gpt55 = runWrapper("claude-gpt", ["--model=gpt-5.5"]);
    expect(gpt55.exitCode).toBe(2);
    expect(gpt55.stderr).toContain("claude-gpt55");
  });

  test("dedicated smaller-window wrappers accept only their own model", () => {
    const gpt55 = runWrapper("claude-gpt55", ["gpt-5.5[1m]"]);
    expect(gpt55.exitCode).toBe(0);
    expect(gpt55.stdout).toContain("selector=claude-gpt55");
    expect(gpt55.stdout).toContain("arg=gpt-5.5");
    expect(gpt55.stdout).not.toContain("[1m]");

    const qwen = runWrapper("local-mlx", ["qwen3.8-local"]);
    expect(qwen.exitCode).toBe(0);
    expect(qwen.stdout).toContain("selector=local-mlx");
    expect(qwen.stdout).toContain("arg=qwen3.8-local");

    expect(runWrapper("claude-gpt55", ["gpt-5.6-sol"]).exitCode).toBe(2);
    expect(runWrapper("local-mlx", ["gpt-5.6-sol"]).exitCode).toBe(2);
  });
});
