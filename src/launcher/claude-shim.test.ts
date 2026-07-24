import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SHIM = resolve(import.meta.dir, "../../bin/ccs-claude-shim");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly raw: string;
  readonly ccs: string;
  readonly rawObservation: string;
  readonly ccsObservation: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ccs-claude-shim-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const raw = join(bin, "raw-claude");
  const ccs = join(bin, "ccs");
  const rawObservation = join(root, "raw.txt");
  const ccsObservation = join(root, "ccs.txt");

  writeFileSync(raw, `#!/bin/sh
printf '%s\n' "$@" > "$CCS_TEST_RAW_OBSERVATION"
printf 'base=%s\nmodel=%s\n' "\${ANTHROPIC_BASE_URL:-}" "\${ANTHROPIC_MODEL:-}" >> "$CCS_TEST_RAW_OBSERVATION"
printf 'launch_parent=%s\nlaunch_creator_kind=%s\nlaunch_creator_ref=%s\ncreator_kind=%s\ncreator_ref=%s\n' "\${CCS_LAUNCH_PARENT_SESSION_ID:-}" "\${CCS_LAUNCH_CREATOR_KIND:-}" "\${CCS_LAUNCH_CREATOR_REF:-}" "\${CCS_CREATOR_KIND:-}" "\${CCS_CREATOR_REF:-}" >> "$CCS_TEST_RAW_OBSERVATION"
exit "\${CCS_TEST_RAW_EXIT:-0}"
`);
  writeFileSync(ccs, `#!/bin/sh
printf '%s\n' "$@" > "$CCS_TEST_CCS_OBSERVATION"
printf 'launch_creator_kind=%s\nlaunch_creator_ref=%s\n' "\${CCS_LAUNCH_CREATOR_KIND:-}" "\${CCS_LAUNCH_CREATOR_REF:-}" >> "$CCS_TEST_CCS_OBSERVATION"
exit "\${CCS_TEST_REGISTER_EXIT:-0}"
`);
  chmodSync(raw, 0o755);
  chmodSync(ccs, 0o755);
  return { root, raw, ccs, rawObservation, ccsObservation };
}

function run(
  f: Fixture,
  args: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([SHIM, ...args], {
    cwd: f.root,
    env: {
      ...process.env,
      CCS_RAW_CLAUDE_PATH: f.raw,
      CCS_BIN: f.ccs,
      CCS_TEST_RAW_OBSERVATION: f.rawObservation,
      CCS_TEST_CCS_OBSERVATION: f.ccsObservation,
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: "",
      CMUX_SURFACE_ID: "",
      CMUX_CUSTOM_CLAUDE_PATH: "",
      CCS_CLAUDE_SHIM_AFTER_CMUX: "",
      CCS_LAUNCH_PARENT_SESSION_ID: "",
      CCS_LAUNCH_CREATOR_KIND: "",
      CCS_LAUNCH_CREATOR_REF: "",
      CCS_CMUX_CLAUDE_WRAPPER_PATH: "",
      ...extraEnvironment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").trim().split("\n");
}

describe("ccs Claude shim", () => {
  test("registers an ordinary new session and injects its id", () => {
    const f = fixture();
    const result = run(f, ["hello"]);
    expect(result.exitCode).toBe(0);

    const registered = lines(f.ccsObservation);
    expect(registered.slice(0, 2)).toEqual(["session", "shim-register"]);
    const idArg = registered.find((line) => line.startsWith("--session-id="));
    expect(idArg).toMatch(/^--session-id=[0-9a-f-]{36}$/);
    expect(registered).toContain(`--cwd=${realpathSync(f.root)}`);

    const raw = lines(f.rawObservation);
    expect(raw[0]).toBe("--session-id");
    expect(raw[1]).toBe(idArg?.slice("--session-id=".length));
    expect(raw[2]).toBe("hello");
  });

  test("adopts a cmux-provided session id without duplicating the flag", () => {
    const f = fixture();
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const result = run(f, ["--settings", "{}", "--session-id", sessionId, "prompt"]);
    expect(result.exitCode).toBe(0);
    expect(lines(f.ccsObservation)).toContain(`--session-id=${sessionId}`);
    expect(lines(f.rawObservation).slice(0, 5)).toEqual([
      "--settings",
      "{}",
      "--session-id",
      sessionId,
      "prompt",
    ]);
  });

  test("passes through resume and non-persistent calls without registration", () => {
    const resume = fixture();
    expect(run(resume, ["--resume", "session-id"], { CCS_TEST_REGISTER_EXIT: "99" }).exitCode).toBe(0);
    expect(lines(resume.rawObservation).slice(0, 2)).toEqual(["--resume", "session-id"]);

    const inference = fixture();
    expect(run(inference, ["-p", "--no-session-persistence", "query"], { CCS_TEST_REGISTER_EXIT: "99" }).exitCode).toBe(0);
    expect(lines(inference.rawObservation).slice(0, 3)).toEqual(["-p", "--no-session-persistence", "query"]);

    const fromPr = fixture();
    expect(run(fromPr, ["--from-pr", "123"], { CCS_TEST_REGISTER_EXIT: "99" }).exitCode).toBe(0);
    expect(lines(fromPr.rawObservation).slice(0, 2)).toEqual(["--from-pr", "123"]);
  });

  test("does not reinterpret prompt or option-value text as control flags", () => {
    const promptFlag = fixture();
    expect(run(promptFlag, ["-p", "--", "-c"]).exitCode).toBe(0);
    expect(lines(promptFlag.ccsObservation).slice(0, 2)).toEqual(["session", "shim-register"]);

    const promptCommand = fixture();
    expect(run(promptCommand, ["-p", "--", "gateway"]).exitCode).toBe(0);
    expect(lines(promptCommand.ccsObservation).slice(0, 2)).toEqual(["session", "shim-register"]);

    const optionValue = fixture();
    expect(run(optionValue, ["--model", "-c", "-p", "prompt"]).exitCode).toBe(0);
    expect(lines(optionValue.ccsObservation).slice(0, 2)).toEqual(["session", "shim-register"]);

    const optionalBeforeSession = fixture();
    const sessionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    expect(run(optionalBeforeSession, ["--debug", "--session-id", sessionId, "prompt"]).exitCode).toBe(0);
    expect(lines(optionalBeforeSession.ccsObservation)).toContain(`--session-id=${sessionId}`);
  });

  test("passes through built-in commands after global options", () => {
    const direct = fixture();
    expect(run(direct, ["gateway", "--help"], { CCS_TEST_REGISTER_EXIT: "99" }).exitCode).toBe(0);
    expect(lines(direct.rawObservation).slice(0, 2)).toEqual(["gateway", "--help"]);

    const afterOption = fixture();
    expect(run(afterOption, ["--model", "opus", "gateway", "--help"], { CCS_TEST_REGISTER_EXIT: "99" }).exitCode).toBe(0);
    expect(lines(afterOption.rawObservation).slice(0, 4)).toEqual(["--model", "opus", "gateway", "--help"]);

    const optionalValueBeforeBuiltin = fixture();
    expect(run(optionalValueBeforeBuiltin, ["--debug", "-v"], { CCS_TEST_REGISTER_EXIT: "99" }).exitCode).toBe(0);
    expect(lines(optionalValueBeforeBuiltin.rawObservation).slice(0, 2)).toEqual(["--debug", "-v"]);

    const commandAsValue = fixture();
    expect(run(commandAsValue, ["--model", "gateway", "-p", "ordinary prompt"]).exitCode).toBe(0);
    expect(lines(commandAsValue.ccsObservation).slice(0, 2)).toEqual(["session", "shim-register"]);

    const variadicValue = fixture();
    expect(run(variadicValue, ["--add-dir", "/tmp", "gateway"]).exitCode).toBe(0);
    expect(lines(variadicValue.ccsObservation).slice(0, 2)).toEqual(["session", "shim-register"]);
  });

  test("blocks obvious unmanaged nested launches", () => {
    const f = fixture();
    const result = run(f, ["-p", "nested"], {
      CLAUDE_CODE_SESSION_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(result.exitCode).toBe(2);
    expect(() => readFileSync(f.rawObservation)).toThrow();
  });

  test("requires an explicit nested session id to already be managed", () => {
    const f = fixture();
    const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const result = run(f, ["--session-id", sessionId, "-p", "nested"], {
      CLAUDE_CODE_SESSION_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      CCS_TEST_REGISTER_EXIT: "3",
    });
    expect(result.exitCode).toBe(2);
    expect(lines(f.ccsObservation)).toContain("--require-existing");
    expect(lines(f.ccsObservation)).toContain("--parent-session-id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(() => readFileSync(f.rawObservation)).toThrow();
  });

  test("uses one-launch automation provenance for verification and removes it from the harness", () => {
    const f = fixture();
    const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const parent = "11111111-1111-4111-8111-111111111111";
    const result = run(f, ["--session-id", sessionId, "-p", "automated"], {
      CCS_LAUNCH_PARENT_SESSION_ID: parent,
      CCS_LAUNCH_CREATOR_KIND: "automation",
      CCS_LAUNCH_CREATOR_REF: "imsg-server",
      CCS_CREATOR_KIND: "automation",
      CCS_CREATOR_REF: "imsg-server",
    });

    expect(result.exitCode).toBe(0);
    const registered = lines(f.ccsObservation);
    expect(registered).toContain("--require-existing");
    expect(registered).toContain(`--parent-session-id=${parent}`);
    expect(registered).toContain("launch_creator_kind=automation");
    expect(registered).toContain("launch_creator_ref=imsg-server");
    const raw = lines(f.rawObservation);
    expect(raw).toContain("launch_parent=");
    expect(raw).toContain("launch_creator_kind=");
    expect(raw).toContain("launch_creator_ref=");
    expect(raw).toContain("creator_kind=");
    expect(raw).toContain("creator_ref=");
  });

  test("preserves nested parentage across cmux identity clearing", () => {
    const f = fixture();
    const wrapper = join(f.root, "cmux-wrapper");
    const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    writeFileSync(wrapper, `#!/bin/sh
unset CLAUDE_CODE_SESSION_ID
exec "$CMUX_CUSTOM_CLAUDE_PATH" --session-id "$CCS_TEST_CMUX_SESSION_ID" --settings '{}' "$@"
`);
    chmodSync(wrapper, 0o755);

    const result = run(f, ["-p", "nested"], {
      CLAUDE_CODE_SESSION_ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      CMUX_SURFACE_ID: "surface:1",
      CMUX_CUSTOM_CLAUDE_PATH: SHIM,
      CCS_CMUX_CLAUDE_WRAPPER_PATH: wrapper,
      CCS_TEST_CMUX_SESSION_ID: sessionId,
      CCS_TEST_REGISTER_EXIT: "3",
    });
    expect(result.exitCode).toBe(2);
    expect(lines(f.ccsObservation)).toContain(`--session-id=${sessionId}`);
    expect(lines(f.ccsObservation)).toContain("--require-existing");
    expect(lines(f.ccsObservation)).toContain("--parent-session-id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(() => readFileSync(f.rawObservation)).toThrow();
  });

  test("preserves provider-selection environment", () => {
    const f = fixture();
    const result = run(f, ["prompt"], {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_MODEL: "gpt-5.6-sol[1m]",
    });
    expect(result.exitCode).toBe(0);
    expect(lines(f.rawObservation)).toContain("base=http://127.0.0.1:8317");
    expect(lines(f.rawObservation)).toContain("model=gpt-5.6-sol[1m]");
  });
});
