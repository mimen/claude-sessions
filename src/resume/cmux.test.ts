import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ResumeCommand } from "./command.ts";
import { openInCmux } from "./cmux.ts";

function withFakeCmux<T>(fn: (cmuxPath: string, callsFile: string, root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ccs-open-cmux-"));
  const cmuxPath = join(root, "fake-cmux");
  const callsFile = join(root, "calls.log");
  writeFileSync(
    cmuxPath,
    `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
`,
    { mode: 0o755 },
  );

  try {
    return fn(cmuxPath, callsFile, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readCmuxArgv(callsFile: string): string[] {
  const argv = readFileSync(callsFile, "utf8").split("\0");
  if (argv.at(-1) === "") argv.pop();
  return argv;
}

function valueAfter(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = argv[index + 1];
  if (index < 0 || value === undefined) throw new Error(`missing ${flag} value`);
  return value;
}

function environmentFileFromCommand(command: string): string {
  const sourcePrefix = "builtin . ";
  if (!command.startsWith(sourcePrefix)) {
    throw new Error("command is not a short transport source line");
  }
  const parsed = Bun.spawnSync(
    ["/bin/bash", "-c", `set -- ${command.slice(sourcePrefix.length)}; printf '%s' "$1"`],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!parsed.success) throw new Error("failed to parse launch file path");
  return join(dirname(parsed.stdout.toString()), "environment.sh");
}

describe("openInCmux", () => {
  test("uses the shared single-use transport instead of ResumeCommand.shell", () => {
    withFakeCmux((cmuxPath, callsFile, root) => {
      const launcherPath = join(root, "capture-launch-env");
      const capturedValuePath = join(root, "captured-value.txt");
      const childEnvironmentPath = join(root, "child.env");
      writeFileSync(
        launcherPath,
        `#!/bin/bash
printf '%s' "$CCS_OPEN_VALUE" > "$1"
/usr/bin/env > "$2"
`,
        { mode: 0o755 },
      );
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
/bin/bash -c "$command"
`,
        { mode: 0o755 },
      );

      const explicitValue = "parent=value with spaces and 'quotes'";
      const command: ResumeCommand = {
        argv: [launcherPath, capturedValuePath, childEnvironmentPath],
        cwd: root,
        env: { CCS_OPEN_VALUE: explicitValue },
        unset: [],
        shell: "legacy shell text that must not be passed",
      };

      expect(openInCmux(command, "resume title", cmuxPath)).toBe(true);

      const calls = readCmuxArgv(callsFile);
      const integratedCommand = valueAfter(calls, "--command");
      const environmentFile = environmentFileFromCommand(integratedCommand);
      expect(calls.slice(-2)).toEqual(["--focus", "true"]);
      expect(calls).not.toContain("--env");
      expect(calls).not.toContain("--env-file");
      expect(calls).not.toContain(command.shell);
      expect(calls.join("\0")).not.toContain(explicitValue);
      expect(readFileSync(capturedValuePath, "utf8")).toBe(explicitValue);
      expect(readFileSync(childEnvironmentPath, "utf8")).toContain(
        `CCS_OPEN_VALUE=${explicitValue}\n`,
      );
      expect(readFileSync(childEnvironmentPath, "utf8")).not.toContain(
        "CCS_CMUX_STAGED_ENV_",
      );
      expect(existsSync(environmentFile)).toBe(false);
    });
  });

  test("fails closed on an invalid environment key without invoking cmux", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      const command: ResumeCommand = {
        argv: ["claude", "--resume", "session-id"],
        cwd: "/tmp",
        env: { "INVALID-NAME": "value" },
        unset: [],
        shell: "unused",
      };

      expect(openInCmux(command, "invalid", cmuxPath)).toBe(false);
      expect(existsSync(callsFile)).toBe(false);
    });
  });
});
