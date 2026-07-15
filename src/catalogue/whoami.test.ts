import { describe, expect, test } from "bun:test";
import { whoami } from "./commands.ts";

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

function captureStreams<T>(fn: () => T): { rc: T; stdout: string; stderr: string } {
  const origLog = console.log;
  const origErr = console.error;
  let stdout = "";
  let stderr = "";
  console.log = (...a: unknown[]) => {
    stdout += a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
  };
  console.error = (...a: unknown[]) => {
    stderr += a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
  };
  try {
    return { rc: fn(), stdout, stderr };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("ccs whoami", () => {
  test("outside a Claude session (CLAUDE_CODE_SESSION_ID unset) → exit 1 with a clear stderr message", () => {
    withEnv("CLAUDE_CODE_SESSION_ID", undefined, () => {
      const { rc, stdout, stderr } = captureStreams(() => whoami());
      expect(rc).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Not inside a Claude Code session");
      expect(stderr).toContain("CLAUDE_CODE_SESSION_ID");
    });
  });

  test("inside a Claude session → exit 0, prints the session id to stdout", () => {
    withEnv("CLAUDE_CODE_SESSION_ID", "abc-123-uuid", () => {
      const { rc, stdout, stderr } = captureStreams(() => whoami());
      expect(rc).toBe(0);
      expect(stdout.trim()).toBe("abc-123-uuid");
      expect(stderr).toBe("");
    });
  });
});
