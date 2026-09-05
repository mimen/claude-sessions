import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { millionWindowClaudeFamilies } from "../resume/role-model-launch.ts";

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

    for (const family of millionWindowClaudeFamilies()) {
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

  test("claudex refuses a model outside its context envelope", () => {
    const stray = runWrapper("claudex", ["gpt-4.1"]);
    expect(stray.exitCode).toBe(2);
    expect(stray.stderr).toContain("outside this launcher's context envelope");
  });

  test("the gateway families claudex serves pass through unmarked", () => {
    for (const model of ["grok-4.6", "glm-5.3-flash", "gpt-5.6-terra[1m]"]) {
      const result = runWrapper("claudex", ["--model", model]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("[1m]");
    }
  });

  test("claude-native takes the canonical Claude spelling verbatim", () => {
    const native = runWrapper("claude-native", ["--model", "claude-opus-5[1m]"]);
    expect(native.exitCode).toBe(0);
    expect(native.stdout).toContain("selector=claude-native");
  });
});
