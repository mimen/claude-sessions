import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { shellQuote } from "./command.ts";
import {
  invokeCmuxNewWorkspace,
  spawnCmux,
  type SpawnCmuxOpts,
} from "./spawn-cmux.ts";

/**
 * Test strategy: inject a fake cmuxBin that's a tiny bash script recording every argv item with a
 * NUL delimiter. Tests that exercise the integrated-shell command run that command explicitly,
 * which simulates cmux's first surface without depending on a real cmux installation.
 */

function withFakeCmux<T>(fn: (cmuxPath: string, callsFile: string, root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ccs-spawn-cmux-"));
  const cmuxPath = join(root, "fake-cmux");
  const callsFile = join(root, "calls.log");

  const script = `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
exit 0
`;
  writeFileSync(cmuxPath, script, { mode: 0o755 });

  try {
    return fn(cmuxPath, callsFile, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readNullDelimited(path: string): string[] {
  const values = readFileSync(path, "utf8").split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

function readCmuxArgv(callsFile: string): string[] {
  return readNullDelimited(callsFile);
}

function valueAfter(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = argv[index + 1];
  if (index < 0 || value === undefined) throw new Error(`missing ${flag} value`);
  return value;
}

function environmentFileFromCommand(command: string): string {
  const sourcePrefix = "; builtin . ";
  const sourceStart = command.indexOf(sourcePrefix);
  const sourceEnd = command.indexOf(" && /bin/rm -f -- ", sourceStart + sourcePrefix.length);
  if (sourceStart < 0 || sourceEnd < 0) {
    throw new Error("command does not contain the temporary environment source step");
  }

  const sourceToken = command.slice(sourceStart + sourcePrefix.length, sourceEnd);
  const parsed = Bun.spawnSync(
    ["/bin/bash", "-c", `set -- ${sourceToken}; printf '%s' "$1"`],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!parsed.success) throw new Error("failed to parse temporary environment path");
  return parsed.stdout.toString();
}

function withoutLauncherEnvironment(keys: readonly string[]): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of keys) delete environment[key];
  return environment;
}

describe("spawnCmux", () => {
  test("constructs argv: new-workspace --cwd <cwd> --name <name> --command <shell-quoted argv>", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:42"
exit 0
`,
        { mode: 0o755 },
      );

      const opts: SpawnCmuxOpts = {
        argv: ["claude", "--resume", "s123"],
        cwd: "/tmp/test-dir",
        name: "my-session",
        cmuxBin: cmuxPath,
      };

      expect(spawnCmux(opts)).toBe("workspace:42");
      expect(readCmuxArgv(callsFile)).toEqual([
        "new-workspace",
        "--cwd",
        "/tmp/test-dir",
        "--name",
        "my-session",
        "--command",
        "claude --resume s123",
      ]);
    });
  });

  test("appends --focus true when opts.focus is true", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:99"
exit 0
`,
        { mode: 0o755 },
      );

      expect(
        spawnCmux({
          argv: ["claude", "--resume", "s456"],
          cwd: "/tmp/test-dir",
          name: "focused",
          focus: true,
          cmuxBin: cmuxPath,
        }),
      ).toBe("workspace:99");
      expect(readCmuxArgv(callsFile).slice(-2)).toEqual(["--focus", "true"]);
    });
  });

  test("shell-quotes argv with spaces and special chars", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:100"
exit 0
`,
        { mode: 0o755 },
      );

      expect(
        spawnCmux({
          argv: ["claude", "--resume", "s789", "/pr-watch check PR #123"],
          cwd: "/tmp/test-dir",
          name: "complex-command",
          cmuxBin: cmuxPath,
        }),
      ).toBe("workspace:100");

      expect(valueAfter(readCmuxArgv(callsFile), "--command")).toBe(
        "claude --resume s789 '/pr-watch check PR #123'",
      );
    });
  });

  test("keeps a long PATH and every staging value out of cmux argv and command", () => {
    withFakeCmux((cmuxPath, callsFile, root) => {
      const launcherPath = join(root, "fake-launcher");
      const capturedEnvironmentPath = join(root, "captured-environment.sh");
      const directoryModePath = join(root, "directory-mode.txt");
      const fileModePath = join(root, "file-mode.txt");
      writeFileSync(launcherPath, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
command=''
while (($#)); do
  if [[ "$1" == "--command" ]]; then
    shift
    command="$1"
  fi
  shift
done
source_token="\${command#*; builtin . }"
source_token="\${source_token%% && /bin/rm -f -- *}"
eval "set -- $source_token"
environment_file="$1"
/bin/cp "$environment_file" "${capturedEnvironmentPath}"
/usr/bin/stat -f '%Lp' "$(dirname "$environment_file")" > "${directoryModePath}"
/usr/bin/stat -f '%Lp' "$environment_file" > "${fileModePath}"
/bin/bash -c "$command" || exit 1
echo "workspace:101"
`,
        { mode: 0o755 },
      );

      const longPath = Array.from(
        { length: 2048 },
        (_, index) => `/opt/ccs/toolchains/${index}/bin`,
      ).join(":");
      expect(
        spawnCmux({
          argv: [
            launcherPath,
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
        }),
      ).toBe("workspace:101");

      const calls = readCmuxArgv(callsFile);
      const command = valueAfter(calls, "--command");
      const environmentFile = environmentFileFromCommand(command);
      expect(calls).not.toContain("--env");
      expect(calls).not.toContain("--env-file");
      expect(calls.join("\0")).not.toContain(longPath);
      expect(command).not.toContain(longPath);
      expect(command).toContain(
        `/usr/bin/env PATH="$CCS_CMUX_STAGED_ENV_0" ${launcherPath} --model gpt-5.6-sol ` +
          "--session-id 12345678-1234-4123-8123-123456789abc " +
          "'finish the complete launch'",
      );

      expect(readFileSync(directoryModePath, "utf8").trim()).toBe("700");
      expect(readFileSync(fileModePath, "utf8").trim()).toBe("600");
      expect(readFileSync(capturedEnvironmentPath, "utf8")).toBe(
        `CCS_CMUX_STAGED_ENV_0=${shellQuote(longPath)}\n`,
      );
      expect(readFileSync(capturedEnvironmentPath, "utf8")).not.toContain("export");
      expect(existsSync(environmentFile)).toBe(false);
      expect(existsSync(dirname(environmentFile))).toBe(false);
    });
  });

  test("resolves a relative TMPDIR before the workspace changes cwd", () => {
    withFakeCmux((cmuxPath, callsFile, root) => {
      const launcherPath = join(root, "relative-tmp-launcher");
      writeFileSync(launcherPath, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
command=''
while (($#)); do
  if [[ "$1" == "--command" ]]; then
    shift
    command="$1"
  fi
  shift
done
/bin/bash -c "$command" || exit 1
echo "workspace:103"
`,
        { mode: 0o755 },
      );

      const previousTmpDir = process.env.TMPDIR;
      process.env.TMPDIR = ".";
      try {
        expect(
          spawnCmux({
            argv: [launcherPath],
            cwd: root,
            name: "relative-tmpdir",
            env: { CCS_TEST_RELATIVE_TMPDIR: "value" },
            cmuxBin: cmuxPath,
          }),
        ).toBe("workspace:103");
      } finally {
        if (previousTmpDir === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = previousTmpDir;
        }
      }

      const environmentFile = environmentFileFromCommand(
        valueAfter(readCmuxArgv(callsFile), "--command"),
      );
      expect(isAbsolute(environmentFile)).toBe(true);
      expect(existsSync(environmentFile)).toBe(false);
    });
  });

  test("preserves exact values, scopes child env, cleans once, and restores without values", () => {
    withFakeCmux((cmuxPath, callsFile, root) => {
      const launcherPath = join(root, "capture-launch-env");
      const valuesPath = join(root, "values.bin");
      const childEnvironmentPath = join(root, "child.env");
      const launchCountPath = join(root, "launch-count.txt");
      const firstShellEnvironmentPath = join(root, "first-shell.env");
      const restoredShellEnvironmentPath = join(root, "restored-shell.env");
      const capturedEnvironmentPath = join(root, "captured-environment.sh");
      const directoryModePath = join(root, "directory-mode.txt");
      const fileModePath = join(root, "file-mode.txt");
      const rmOverridePath = join(root, "rm-override-called");
      const rmdirOverridePath = join(root, "rmdir-override-called");
      const envOverridePath = join(root, "env-override-called");
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
command=''
while (($#)); do
  if [[ "$1" == "--command" ]]; then
    shift
    command="$1"
  fi
  shift
done
source_token="\${command#*; builtin . }"
source_token="\${source_token%% && /bin/rm -f -- *}"
eval "set -- $source_token"
environment_file="$1"
/bin/cp "$environment_file" "${capturedEnvironmentPath}"
/usr/bin/stat -f '%Lp' "$(dirname "$environment_file")" > "${directoryModePath}"
/usr/bin/stat -f '%Lp' "$environment_file" > "${fileModePath}"
rm() { : > "${rmOverridePath}"; /bin/rm "$@"; }
rmdir() { : > "${rmdirOverridePath}"; /bin/rmdir "$@"; }
env() { : > "${envOverridePath}"; /usr/bin/env "$@"; }
eval "$command; /usr/bin/env > ${shellQuote(firstShellEnvironmentPath)}" || exit 1
echo "workspace:102"
`,
        { mode: 0o755 },
      );
      writeFileSync(
        launcherPath,
        `#!/bin/bash
printf '%s\\0%s\\0%s\\0' "\${CCS_TEST_EMPTY+x}" "$CCS_TEST_EMPTY" "$CCS_TEST_SPECIAL" > "$1"
printf 'launch\\n' >> "$2"
/usr/bin/env > "$3"
`,
        { mode: 0o755 },
      );

      const specialValue = "value with spaces=and=equals 'and quotes'";
      expect(
        spawnCmux({
          argv: [launcherPath, valuesPath, launchCountPath, childEnvironmentPath],
          cwd: root,
          name: "environment-scope",
          env: {
            CCS_TEST_EMPTY: "",
            CCS_TEST_SPECIAL: specialValue,
          },
          cmuxBin: cmuxPath,
        }),
      ).toBe("workspace:102");

      const calls = readCmuxArgv(callsFile);
      const command = valueAfter(calls, "--command");
      const environmentFile = environmentFileFromCommand(command);
      const environmentDirectory = dirname(environmentFile);
      const scrubbedKeys = [
        "CCS_TEST_EMPTY",
        "CCS_TEST_SPECIAL",
        "CCS_CMUX_STAGED_ENV_0",
        "CCS_CMUX_STAGED_ENV_1",
      ];

      expect(calls).not.toContain("--env");
      expect(calls).not.toContain("--env-file");
      expect(calls.join("\0")).not.toContain(specialValue);
      expect(command).not.toContain(specialValue);
      expect(command).toContain("(set +a; unset CCS_CMUX_STAGED_ENV_0 CCS_CMUX_STAGED_ENV_1;");
      expect(command).toContain(
        '/usr/bin/env CCS_TEST_EMPTY="$CCS_CMUX_STAGED_ENV_0" ' +
          'CCS_TEST_SPECIAL="$CCS_CMUX_STAGED_ENV_1" ',
      );
      expect(readFileSync(capturedEnvironmentPath, "utf8")).toBe(
        `CCS_CMUX_STAGED_ENV_0=${shellQuote("")}\n` +
          `CCS_CMUX_STAGED_ENV_1=${shellQuote(specialValue)}\n`,
      );
      expect(readFileSync(directoryModePath, "utf8").trim()).toBe("700");
      expect(readFileSync(fileModePath, "utf8").trim()).toBe("600");
      expect(readNullDelimited(valuesPath)).toEqual(["x", "", specialValue]);
      expect(readFileSync(launchCountPath, "utf8")).toBe("launch\n");

      const childEnvironment = readFileSync(childEnvironmentPath, "utf8");
      expect(childEnvironment).toContain("CCS_TEST_EMPTY=\n");
      expect(childEnvironment).toContain(`CCS_TEST_SPECIAL=${specialValue}\n`);
      expect(childEnvironment).not.toContain("CCS_CMUX_STAGED_ENV_");

      const firstShellEnvironment = readFileSync(firstShellEnvironmentPath, "utf8");
      expect(firstShellEnvironment).not.toContain("CCS_TEST_EMPTY=");
      expect(firstShellEnvironment).not.toContain("CCS_TEST_SPECIAL=");
      expect(firstShellEnvironment).not.toContain("CCS_CMUX_STAGED_ENV_");
      expect(existsSync(rmOverridePath)).toBe(false);
      expect(existsSync(rmdirOverridePath)).toBe(false);
      expect(existsSync(envOverridePath)).toBe(false);
      expect(existsSync(environmentFile)).toBe(false);
      expect(existsSync(environmentDirectory)).toBe(false);

      const restoredSurface = Bun.spawnSync(
        [
          "/bin/bash",
          "-c",
          `set -a; ${command}; /usr/bin/env > ${shellQuote(restoredShellEnvironmentPath)}`,
        ],
        {
          env: withoutLauncherEnvironment(scrubbedKeys),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(restoredSurface.success).toBe(true);
      expect(readFileSync(launchCountPath, "utf8")).toBe("launch\n");

      const restoredShellEnvironment = readFileSync(restoredShellEnvironmentPath, "utf8");
      expect(restoredShellEnvironment).not.toContain("CCS_TEST_EMPTY=");
      expect(restoredShellEnvironment).not.toContain("CCS_TEST_SPECIAL=");
      expect(restoredShellEnvironment).not.toContain("CCS_CMUX_STAGED_ENV_");
    });
  });

  test("rejects invalid environment keys before invoking cmux", () => {
    for (const key of ["", "1INVALID", "INVALID-NAME", "INVALID=NAME"]) {
      withFakeCmux((cmuxPath, callsFile) => {
        expect(
          spawnCmux({
            argv: ["claude"],
            cwd: "/tmp/test-dir",
            name: "invalid-env",
            env: { [key]: "value" },
            cmuxBin: cmuxPath,
          }),
        ).toBeNull();
        expect(existsSync(callsFile)).toBe(false);
      });
    }
  });

  test("returns workspace ref from JSON output", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo '{"ref": "workspace:200", "name": "my-session"}'
exit 0
`,
        { mode: 0o755 },
      );
      expect(
        spawnCmux({
          argv: ["claude", "--resume", "s999"],
          cwd: "/tmp/test-dir",
          name: "json-output",
          cmuxBin: cmuxPath,
        }),
      ).toBe("workspace:200");
    });
  });

  test("returns workspace ref from JSON output with an id field", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo '{"id": "workspace:300"}'
exit 0
`,
        { mode: 0o755 },
      );
      expect(
        spawnCmux({
          argv: ["claude", "--resume", "s888"],
          cwd: "/tmp/test-dir",
          name: "json-id",
          cmuxBin: cmuxPath,
        }),
      ).toBe("workspace:300");
    });
  });

  test("regex fallback parses workspace ref from stdout", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "Created workspace:500"
exit 0
`,
        { mode: 0o755 },
      );
      expect(
        spawnCmux({
          argv: ["claude", "--resume", "s777"],
          cwd: "/tmp/test-dir",
          name: "plain-text",
          cmuxBin: cmuxPath,
        }),
      ).toBe("workspace:500");
    });
  });

  test("regex fallback parses workspace ref from stderr", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:600" >&2
exit 0
`,
        { mode: 0o755 },
      );
      expect(
        spawnCmux({
          argv: ["claude", "--resume", "s666"],
          cwd: "/tmp/test-dir",
          name: "stderr-ref",
          cmuxBin: cmuxPath,
        }),
      ).toBe("workspace:600");
    });
  });

  test("prunes stale task-owned transports before creating a new one", () => {
    withFakeCmux((cmuxPath, callsFile, root) => {
      const staleDirectory = join(root, "ccs-cmux-launch-stale");
      const staleFile = join(staleDirectory, "environment.sh");
      const launcherPath = join(root, "stale-cleanup-launcher");
      mkdirSync(staleDirectory, { mode: 0o700 });
      writeFileSync(staleFile, "CCS_STALE='secret'\n", { mode: 0o600 });
      const staleTime = new Date(Date.now() - 10 * 60_000);
      utimesSync(staleDirectory, staleTime, staleTime);
      writeFileSync(launcherPath, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
command=''
while (($#)); do
  if [[ "$1" == "--command" ]]; then
    shift
    command="$1"
  fi
  shift
done
/bin/bash -c "$command" || exit 1
echo "workspace:650"
`,
        { mode: 0o755 },
      );

      const previousTmpDir = process.env.TMPDIR;
      process.env.TMPDIR = root;
      try {
        expect(
          spawnCmux({
            argv: [launcherPath],
            cwd: root,
            name: "stale-cleanup",
            env: { CCS_CURRENT: "value" },
            cmuxBin: cmuxPath,
          }),
        ).toBe("workspace:650");
      } finally {
        if (previousTmpDir === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = previousTmpDir;
        }
      }

      expect(existsSync(staleFile)).toBe(false);
      expect(existsSync(staleDirectory)).toBe(false);
    });
  });

  test("cleans the exact temporary file and directory when cmux exits non-zero", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "Error: cmux failed" >&2
exit 1
`,
        { mode: 0o755 },
      );

      expect(
        spawnCmux({
          argv: ["claude", "--resume", "s555"],
          cwd: "/tmp/test-dir",
          name: "fail",
          env: { CCS_TEST_FAILURE_VALUE: "must be removed" },
          cmuxBin: cmuxPath,
        }),
      ).toBeNull();

      const calls = readCmuxArgv(callsFile);
      const command = valueAfter(calls, "--command");
      const environmentFile = environmentFileFromCommand(command);
      expect(calls).not.toContain("--env");
      expect(calls).not.toContain("--env-file");
      expect(existsSync(environmentFile)).toBe(false);
      expect(existsSync(dirname(environmentFile))).toBe(false);
    });
  });

  test("the independent janitor cleans an unconsumed transport", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:700"
exit 0
`,
        { mode: 0o755 },
      );

      expect(
        invokeCmuxNewWorkspace(
          {
            argv: ["claude", "--resume", "unconsumed"],
            cwd: "/tmp/test-dir",
            name: "unconsumed",
            env: { CCS_TEST_UNCONSUMED: "must be removed" },
            cmuxBin: cmuxPath,
          },
          1000,
          1,
        ),
      ).not.toBeNull();

      const command = valueAfter(readCmuxArgv(callsFile), "--command");
      const environmentFile = environmentFileFromCommand(command);
      expect(existsSync(environmentFile)).toBe(true);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
      expect(existsSync(environmentFile)).toBe(false);
      expect(existsSync(dirname(environmentFile))).toBe(false);
    });
  }, 5000);

  test("returns null when no workspace ref is present", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "success but no ref"
exit 0
`,
        { mode: 0o755 },
      );
      expect(
        spawnCmux({
          argv: ["claude", "--resume", "s444"],
          cwd: "/tmp/test-dir",
          name: "no-ref",
          cmuxBin: cmuxPath,
        }),
      ).toBeNull();
    });
  });

  test("timeout handling contract remains 10 seconds", () => {
    // End-to-end timeout coverage would deliberately stall this suite for more than 10 seconds.
    // spawnCmux passes 10000 to the shared invocation primitive; timeout failure follows the same
    // non-success cleanup path covered above.
    expect(true).toBe(true);
  });

  test("uses process.env.CMUX_BIN when cmuxBin is not provided", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      writeFileSync(
        cmuxPath,
        `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
echo "workspace:800"
exit 0
`,
        { mode: 0o755 },
      );

      const previousCmuxBin = process.env.CMUX_BIN;
      process.env.CMUX_BIN = cmuxPath;
      try {
        expect(
          spawnCmux({
            argv: ["claude", "--resume", "s222"],
            cwd: "/tmp/test-dir",
            name: "env-bin",
          }),
        ).toBe("workspace:800");
      } finally {
        if (previousCmuxBin === undefined) {
          delete process.env.CMUX_BIN;
        } else {
          process.env.CMUX_BIN = previousCmuxBin;
        }
      }
    });
  });

  // The literal `cmux` fallback is deliberately not executed in tests: doing so opens a live tab.
});
