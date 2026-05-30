import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { buildResumeCommand, shellQuote, resolveResumeCwd } from "./command.ts";
import { resolveTarget } from "./target.ts";
import type { SessionRow } from "../index/index.ts";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "abc-123", host: "h", path: "/p", cwd: "/c", projectRoot: "/c",
    projectName: "c", branch: null, version: null, firstTs: null, lastTs: null,
    msgCount: 0, fileSize: 0, title: "t", titleSource: "fallback",
    isSubagent: false, parentSessionId: null, ...over,
  };
}

test("buildResumeCommand: in-place vs fork", () => {
  const plain = buildResumeCommand(row(), { fork: false, cwd: "/x" });
  expect(plain.argv).toEqual(["claude", "--resume", "abc-123"]);
  expect(plain.cwd).toBe("/x");

  const forked = buildResumeCommand(row(), { fork: true, cwd: "/x" });
  expect(forked.argv).toEqual(["claude", "--resume", "abc-123", "--fork-session"]);
  expect(forked.shell).toBe("claude --resume abc-123 --fork-session");
});

test("shellQuote leaves safe tokens, quotes spaces", () => {
  expect(shellQuote("abc-123")).toBe("abc-123");
  expect(shellQuote("/a/b c")).toBe("'/a/b c'");
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
});

test("resolveResumeCwd: existing cwd kept; missing falls back", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-resume-"));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });

  expect(resolveResumeCwd(row({ cwd: repo, projectRoot: repo })).note).toBeNull();

  const gone = resolveResumeCwd(row({ cwd: "/no/such/dir", projectRoot: repo }));
  expect(gone.cwd).toBe(repo);
  expect(gone.note).toContain("project root");

  const allGone = resolveResumeCwd(row({ cwd: "/no/such/dir", projectRoot: "/also/gone" }));
  expect(allGone.cwd).toBe(homedir());
  expect(allGone.note).toContain("home");

  rmSync(dir, { recursive: true, force: true });
});

test("resolveTarget: pin, auto, and forceOther flip", () => {
  expect(resolveTarget("inline", true)).toBe("inline");
  expect(resolveTarget("cmux", false)).toBe("cmux");
  expect(resolveTarget("auto", true)).toBe("cmux");
  expect(resolveTarget("auto", false)).toBe("inline");
  // override flips the resolved base
  expect(resolveTarget("auto", true, true)).toBe("inline");
  expect(resolveTarget("auto", false, true)).toBe("cmux");
});
