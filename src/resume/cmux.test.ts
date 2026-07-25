import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResumeCommand } from "./command.ts";
import { openInCmux } from "./cmux.ts";
import { buildCmuxNewWorkspaceArgv } from "./spawn-cmux.ts";

function withFakeCmux<T>(fn: (cmuxPath: string, callsFile: string) => T): T {
  const tmpDir = mkdtempSync(join(tmpdir(), "ccs-open-cmux-"));
  const cmuxPath = join(tmpDir, "fake-cmux");
  const callsFile = join(tmpDir, "calls.log");
  writeFileSync(cmuxPath, `#!/bin/bash
printf '%s\\0' "$@" > "${callsFile}"
`, { mode: 0o755 });

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

describe("openInCmux", () => {
  test("uses the shared new-workspace argv builder instead of ResumeCommand.shell", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      const command: ResumeCommand = {
        argv: ["claude-gpt", "--resume", "session id"],
        cwd: "/tmp/resume cwd",
        env: { CCS_LAUNCH_CREATOR_REF: "parent=value with spaces" },
        shell: "legacy shell text that must not be passed",
      };
      const expected = buildCmuxNewWorkspaceArgv({
        argv: command.argv,
        cwd: command.cwd,
        env: command.env,
        name: "resume title",
        focus: true,
      });
      expect(expected.ok).toBe(true);
      if (!expected.ok) return;

      expect(openInCmux(command, "resume title", cmuxPath)).toBe(true);
      expect(readCmuxArgv(callsFile)).toEqual(expected.value);
      expect(expected.value.slice(-2)).toEqual(["--focus", "true"]);
      expect(expected.value).not.toContain(command.shell);
    });
  });

  test("fails closed on an invalid environment key without invoking cmux", () => {
    withFakeCmux((cmuxPath, callsFile) => {
      const command: ResumeCommand = {
        argv: ["claude", "--resume", "session-id"],
        cwd: "/tmp",
        env: { "INVALID-NAME": "value" },
        shell: "unused",
      };

      expect(openInCmux(command, "invalid", cmuxPath)).toBe(false);
      expect(existsSync(callsFile)).toBe(false);
    });
  });
});
