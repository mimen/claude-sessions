import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MILLION_WINDOW_CLAUDE_FAMILIES } from "../resume/role-model-launch.ts";

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
  test("claudex declares each model family's real context window", () => {
    const opus = runWrapper("claudex", ["--model", "claude-opus-5", "-p", "hello"]);
    expect(opus.exitCode).toBe(0);
    expect(opus.stdout).toContain("selector=claudex");
    expect(opus.stdout).toContain("arg=--model");
    expect(opus.stdout).toContain("arg=claude-opus-5[1m]");

    const fable = runWrapper("claudex", ["claude-fable-5-1", "-p", "hello"]);
    expect(fable.exitCode).toBe(0);
    expect(fable.stdout).toContain("arg=claude-fable-5-1[1m]");

    const sonnet = runWrapper("claudex", ["--model=claude-sonnet-5", "-p", "hello"]);
    expect(sonnet.exitCode).toBe(0);
    expect(sonnet.stdout).toContain("arg=--model=claude-sonnet-5[1m]");

    for (const family of MILLION_WINDOW_CLAUDE_FAMILIES) {
      const model = `${family}test`;
      const result = runWrapper("claudex", [`--model=${model}`, "-p", "hello"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`arg=--model=${model}[1m]`);
    }

    const haiku = runWrapper("claudex", ["--model=claude-haiku-4-5[1m]", "-p", "hello"]);
    expect(haiku.exitCode).toBe(0);
    expect(haiku.stdout).toContain("arg=--model=claude-haiku-4-5");
    expect(haiku.stdout).not.toContain("[1m]");

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
    const gpt56 = runWrapper("claude-gpt", ["--model", "gpt-5.6-terra[1m]"]);
    expect(gpt56.exitCode).toBe(0);
    expect(gpt56.stdout).toContain("selector=claude-gpt");
    expect(gpt56.stdout).toContain("arg=--model");
    expect(gpt56.stdout).toContain("arg=gpt-5.6-terra");
    expect(gpt56.stdout).not.toContain("[1m]");

    const gpt55 = runWrapper("claude-gpt", ["--model=gpt-5.5"]);
    expect(gpt55.exitCode).toBe(2);
    expect(gpt55.stderr).toContain("claude-gpt55");
  });

  test("dedicated smaller-window wrappers accept only their own model", () => {
    const gpt55 = runWrapper("claude-gpt55", ["--model", "gpt-5.5[1m]"]);
    expect(gpt55.exitCode).toBe(0);
    expect(gpt55.stdout).toContain("selector=claude-gpt55");
    expect(gpt55.stdout).toContain("arg=--model");
    expect(gpt55.stdout).toContain("arg=gpt-5.5");
    expect(gpt55.stdout).not.toContain("[1m]");

    const qwen = runWrapper("local-mlx", ["--model", "qwen3.8-local"]);
    expect(qwen.exitCode).toBe(0);
    expect(qwen.stdout).toContain("selector=local-mlx");
    expect(qwen.stdout).toContain("arg=--model");
    expect(qwen.stdout).toContain("arg=qwen3.8-local");

    expect(runWrapper("claude-gpt55", ["gpt-5.6-sol"]).exitCode).toBe(2);
    expect(runWrapper("local-mlx", ["gpt-5.6-sol"]).exitCode).toBe(2);
  });
});
