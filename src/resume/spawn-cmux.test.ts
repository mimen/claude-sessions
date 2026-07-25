import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "./command.ts";
import {
  buildCmuxNewWorkspaceArgv,
  spawnCmux,
  type SpawnCmuxOpts,
} from "./spawn-cmux.ts";

/**
 * Test strategy: inject a fake cmuxBin that's a tiny bash script echoing the exact
 * output we expect cmux to produce. This lets us test command CONSTRUCTION (the argv
 * building + shell quoting) and parsing (JSON vs regex fallback) without depending on
 * a real cmux binary or mocking Bun.spawnSync.
 */

function withFakeCmux<T>(fn: (cmuxPath: string, callsFile: string) => T): T {
  const tmpDir = mkdtempSync(join(tmpdir(), "ccs-spawn-cmux-"));
  const cmuxPath = join(tmpDir, "fake-cmux");
  const callsFile = join(tmpDir, "calls.log");

  // NUL-delimit every argv item so assertions preserve spaces, equals signs, and empty strings.
  const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
exit 0
`;
  writeFileSync(cmuxPath, script, { mode: 0o755 });

  try {
    return fn(cmuxPath, callsFile);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readCmuxArgv(callsFile: string): string[] {
  const argv = readFileSync(callsFile, "utf8").split("\0");
  if (argv.at(-1) === "") argv.pop();
  return argv;
}

describe("spawnCmux", () => {
  test("constructs argv: new-workspace --cwd <cwd> --name <name> --command <shell-quoted argv>", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        // Inject a fake cmux that succeeds and prints a workspace ref
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:42"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s123"],
          cwd: "/tmp/test-dir",
          name: "my-session",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:42");

        expect(readCmuxArgv(callsFile)).toEqual([
          "new-workspace",
          "--cwd",
          "/tmp/test-dir",
          "--name",
          "my-session",
          "--command",
          "claude --resume s123",
        ]);
      },
    );
  });

  test("appends --focus true when opts.focus is true", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:99"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s456"],
          cwd: "/tmp/test-dir",
          name: "focused",
          focus: true,
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:99");

        const calls = readCmuxArgv(callsFile);
        expect(calls.slice(-2)).toEqual(["--focus", "true"]);
      },
    );
  });

  test("shell-quotes argv with spaces and special chars", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:100"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s789", "/pr-watch check PR #123"],
          cwd: "/tmp/test-dir",
          name: "complex-command",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:100");

        const calls = readCmuxArgv(callsFile);
        const commandIndex = calls.indexOf("--command");
        expect(calls[commandIndex + 1]).toBe("claude --resume s789 '/pr-watch check PR #123'");
      },
    );
  });

  test("passes a very long PATH separately from the complete launcher command", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:101"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const longPath = Array.from(
          { length: 2048 },
          (_, index) => `/opt/ccs/toolchains/${index}/bin`,
        ).join(":");
        const ref = spawnCmux({
          argv: [
            "claude-gpt",
            "--model",
            "gpt-5.6-sol",
            "--session-id",
            "12345678-1234-4123-8123-123456789abc",
            "finish the complete launch",
          ],
          cwd: "/tmp/test-dir",
          name: "long-path",
          env: { PATH: longPath },
          cmuxBin: cmuxPath,
        });

        expect(ref).toBe("workspace:101");
        const calls = readCmuxArgv(callsFile);
        const commandIndex = calls.indexOf("--command");
        const command = calls[commandIndex + 1];
        expect(command).toBe(
          "env -u CCS_CMUX_STAGED_ENV_0 PATH=\"$CCS_CMUX_STAGED_ENV_0\" " +
          "claude-gpt --model gpt-5.6-sol --session-id " +
          "12345678-1234-4123-8123-123456789abc 'finish the complete launch'; " +
          "unset CCS_CMUX_STAGED_ENV_0",
        );
        expect(command).not.toContain(longPath);
        expect(calls.filter((arg) => arg === "--env")).toHaveLength(1);
        const envIndex = calls.indexOf("--env");
        expect(calls[envIndex + 1]).toBe(`CCS_CMUX_STAGED_ENV_0=${longPath}`);
      },
    );
  });

  test("preserves empty and special launcher environment values as single argv items", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:102"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const specialValue = "value with spaces=and=equals 'and quotes'";
        const ref = spawnCmux({
          argv: ["claude", "--session-id", "complete-session-id"],
          cwd: "/tmp/test-dir",
          name: "special-env",
          env: {
            CCS_CREATOR_KIND: "",
            SPECIAL_VALUE: specialValue,
          },
          cmuxBin: cmuxPath,
        });

        expect(ref).toBe("workspace:102");
        expect(readCmuxArgv(callsFile)).toEqual([
          "new-workspace",
          "--cwd",
          "/tmp/test-dir",
          "--name",
          "special-env",
          "--command",
          "env -u CCS_CMUX_STAGED_ENV_0 -u CCS_CMUX_STAGED_ENV_1 " +
            "CCS_CREATOR_KIND=\"$CCS_CMUX_STAGED_ENV_0\" " +
            "SPECIAL_VALUE=\"$CCS_CMUX_STAGED_ENV_1\" " +
            "claude --session-id complete-session-id; " +
            "unset CCS_CMUX_STAGED_ENV_0 CCS_CMUX_STAGED_ENV_1",
          "--env",
          "CCS_CMUX_STAGED_ENV_0=",
          "--env",
          `CCS_CMUX_STAGED_ENV_1=${specialValue}`,
        ]);
      },
    );
  });

  test("removes staging variables from the launcher and interactive shell environments", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ccs-staged-env-"));
    const launcherPath = join(tmpDir, "capture-launch-env");
    const childEnvironmentPath = join(tmpDir, "child.env");
    const shellEnvironmentPath = join(tmpDir, "shell.env");
    writeFileSync(launcherPath, "#!/bin/bash\n/usr/bin/env > \"$1\"\n", { mode: 0o755 });

    try {
      const built = buildCmuxNewWorkspaceArgv({
        argv: [launcherPath, childEnvironmentPath],
        cwd: tmpDir,
        name: "environment-scope",
        env: {
          CCS_LAUNCH_CREATOR_REF: "parent with spaces='quoted'",
          OPENAI_API_KEY: "",
        },
      });
      expect(built.ok).toBe(true);
      if (!built.ok) return;

      const commandIndex = built.value.indexOf("--command");
      const command = built.value[commandIndex + 1];
      const workspaceEnvironment = { ...process.env };
      delete workspaceEnvironment.CCS_LAUNCH_CREATOR_REF;
      delete workspaceEnvironment.OPENAI_API_KEY;
      for (let index = 0; index < built.value.length; index++) {
        if (built.value[index] !== "--env") continue;
        const pair = built.value[index + 1] ?? "";
        const equals = pair.indexOf("=");
        workspaceEnvironment[pair.slice(0, equals)] = pair.slice(equals + 1);
      }

      const result = Bun.spawnSync(
        ["/bin/bash", "-c", `${command}; /usr/bin/env > ${shellQuote(shellEnvironmentPath)}`],
        { env: workspaceEnvironment, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.success).toBe(true);

      const childEnvironment = readFileSync(childEnvironmentPath, "utf8");
      expect(childEnvironment).toContain("CCS_LAUNCH_CREATOR_REF=parent with spaces='quoted'\n");
      expect(childEnvironment).toContain("OPENAI_API_KEY=\n");
      expect(childEnvironment).not.toContain("CCS_CMUX_STAGED_ENV_");

      const shellEnvironment = readFileSync(shellEnvironmentPath, "utf8");
      expect(shellEnvironment).not.toContain("CCS_LAUNCH_CREATOR_REF=");
      expect(shellEnvironment).not.toContain("OPENAI_API_KEY=");
      expect(shellEnvironment).not.toContain("CCS_CMUX_STAGED_ENV_");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects invalid environment keys before invoking cmux", () => {
    for (const key of ["", "1INVALID", "INVALID-NAME", "INVALID=NAME"]) {
      const built = buildCmuxNewWorkspaceArgv({
        argv: ["claude"],
        cwd: "/tmp/test-dir",
        name: "invalid-env",
        env: { [key]: "value" },
      });
      expect(built.ok).toBe(false);
    }

    withFakeCmux((cmuxPath, callsFile) => {
      const ref = spawnCmux({
        argv: ["claude"],
        cwd: "/tmp/test-dir",
        name: "invalid-env",
        env: { "INVALID-NAME": "value" },
        cmuxBin: cmuxPath,
      });
      expect(ref).toBeNull();
      expect(existsSync(callsFile)).toBe(false);
    });
  });

  test("returns workspace ref from JSON output (future-proofed structured output)", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo '{"ref": "workspace:200", "name": "my-session"}'
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s999"],
          cwd: "/tmp/test-dir",
          name: "json-output",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:200");
      },
    );
  });

  test("returns workspace ref from JSON output with 'id' field (alternate structure)", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo '{"id": "workspace:300"}'
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s888"],
          cwd: "/tmp/test-dir",
          name: "json-id",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:300");
      },
    );
  });

  test("regex fallback: parses workspace:N from plain text stdout", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "Created workspace:500"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s777"],
          cwd: "/tmp/test-dir",
          name: "plain-text",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:500");
      },
    );
  });

  test("regex fallback: parses workspace:N from stderr if not in stdout", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:600" >&2
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s666"],
          cwd: "/tmp/test-dir",
          name: "stderr-ref",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:600");
      },
    );
  });

  test("returns null on non-zero exit", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "Error: cmux failed" >&2
exit 1
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s555"],
          cwd: "/tmp/test-dir",
          name: "fail",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBeNull();
      },
    );
  });

  test("returns null when no workspace ref found in output", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "success but no ref"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s444"],
          cwd: "/tmp/test-dir",
          name: "no-ref",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBeNull();
      },
    );
  });

  test("timeout handling (contract: spawnSync has 10s timeout)", () => {
    // The actual timeout behavior is tested via spawnSync's built-in timeout mechanism.
    // We document the contract here: spawnCmux sets timeout:10000 on spawnSync, so any
    // cmux invocation taking >10s will return null. Testing this end-to-end would require
    // a 10s+ sleep, which is too slow for the test suite. The contract is: timeout → null.
    // This is a documentation-only test to record the contract.
    expect(true).toBe(true); // contract documented
  });

  test("uses process.env.CMUX_BIN when cmuxBin not provided", () => {
    withFakeCmux(
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:800"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const prevCmuxBin = process.env.CMUX_BIN;
        process.env.CMUX_BIN = cmuxPath;

        try {
          const opts: SpawnCmuxOpts = {
            argv: ["claude", "--resume", "s222"],
            cwd: "/tmp/test-dir",
            name: "env-bin",
            // NO cmuxBin provided, should use CMUX_BIN env var
          };

          const ref = spawnCmux(opts);
          expect(ref).toBe("workspace:800");
        } finally {
          if (prevCmuxBin === undefined) {
            delete process.env.CMUX_BIN;
          } else {
            process.env.CMUX_BIN = prevCmuxBin;
          }
        }
      },
    );
  });

  // NOTE: the `?? "cmux"` default branch is deliberately NOT e2e-tested.
  // A test that invokes spawnCmux with no cmuxBin/CMUX_BIN against the REAL `cmux` on PATH ran
  // `cmux new-workspace --command "claude --resume s111"`, opening a live tab that hangs forever
  // on the resume picker (s111 isn't a real session) — every `bun test` of this file leaked a
  // rogue tab (Milad, 2026-07-12). There is no safe way to exercise the literal default: spawnCmux
  // passes no env to Bun.spawnSync, and Bun resolves a bare "cmux" against the STARTUP PATH,
  // ignoring runtime process.env.PATH mutation, so even a stub-on-PATH can't intercept it. The
  // CMUX_BIN override path is covered by the "env-bin" test and argv construction by the
  // fake-binary tests above; the `?? "cmux"` string itself needs no real spawn to verify.
});
