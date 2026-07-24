import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { buildResumeCommand, shellQuote, resolveResumeCwd } from "./command.ts";
import { resolveTarget } from "./target.ts";
import { encodePath } from "./locate.ts";
import type { SessionRow } from "../index/index.ts";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "abc-123", host: "h", path: "/p", cwd: "/c", projectRoot: "/c",
    projectName: "c", branch: null, version: null, firstTs: null, lastTs: null,
    msgCount: 0, fileSize: 0, title: "t", titleSource: "fallback",
    isSubagent: false, parentSessionId: null, resumeId: "resume-xyz", costUSD: 0, tokInput: 0, tokOutput: 0, tokCacheRead: 0, tokCacheWrite: 0, costByModel: {}, models: [], userTurns: 0, tickIntervalSec: 0, ...over,
  };
}

test("buildResumeCommand uses resumeId (internal id), NOT the filename sessionId", () => {
  // Regression guard: resuming by filename id fails for resumed/forked sessions
  // ("No conversation found"). claude --resume needs the internal sessionId.
  const r = row({ sessionId: "filename-id", resumeId: "internal-id" });
  const plain = buildResumeCommand(r, { fork: false, cwd: "/x" });
  expect(plain.argv).toEqual(["claude", "--resume", "internal-id"]);
  expect(plain.cwd).toBe("/x");

  const forked = buildResumeCommand(r, { fork: true, cwd: "/x" });
  expect(forked.argv).toEqual(["claude", "--resume", "internal-id", "--fork-session"]);
  expect(forked.shell).toBe("claude --resume internal-id --fork-session");
});

test("shellQuote leaves safe tokens, quotes spaces", () => {
  expect(shellQuote("abc-123")).toBe("abc-123");
  expect(shellQuote("/a/b c")).toBe("'/a/b c'");
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
});

test("resolveResumeCwd: existing cwd kept; missing falls back", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ccs-resume-")));
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const repoPath = join(dir, ".projects", encodePath(repo), "s.jsonl");

  const ok1 = resolveResumeCwd(row({ path: repoPath, cwd: repo, projectRoot: repo }));
  if ("error" in ok1) throw new Error("should succeed");
  expect(ok1.note).toBeNull();

  const gone = resolveResumeCwd(row({ path: "/p", cwd: "/no/such/dir", projectRoot: repo }));
  if ("error" in gone) throw new Error("should succeed");
  expect(gone.cwd).toBe(repo);
  expect(gone.note).toContain("project root");

  const allGone = resolveResumeCwd(row({ path: "/p", cwd: "/no/such/dir", projectRoot: "/also/gone" }));
  if ("error" in allGone) throw new Error("should succeed");
  expect(allGone.cwd).toBe(homedir());
  expect(allGone.note).toContain("home");

  rmSync(dir, { recursive: true, force: true });
});

test("resolveResumeCwd locates the launch dir from the storage folder, not the recorded cwd (Figma bug)", () => {
  // The authoritative pointer is the file's storage folder, not the recorded cwd (which drifts
  // when a symlinked cwd is later changed). Build a real dir, name a storage folder after it,
  // and give the row an orphaned cwd — resume must still find the real dir.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-loc-")));
  const vault = join(base, "My Vault"); // space exercises the lossy encoding
  mkdirSync(vault, { recursive: true });
  const folder = encodePath(vault);
  const path = join(base, ".projects", folder, "session.jsonl");

  const out = resolveResumeCwd(row({ path, cwd: "/orphaned/old/path", projectRoot: "/orphaned/old" }));
  if ("error" in out) throw new Error("should succeed");
  expect(out.cwd).toBe(vault); // located via the folder, not the orphaned cwd
  expect(out.note).toContain("no longer maps");

  rmSync(base, { recursive: true, force: true });
});

test("`ccs resume <bogus>` on a fresh CCS_ROOT exits 1 with a clean 'no match' message, not a SQLite stack trace", async () => {
  // Regression: `resumeSelector` opened the Index and Catalogue DBs without
  // calling ensureDataDir() first, so on any fresh CCS_ROOT (no ~/.ccs/cache
  // yet) the SQLite driver threw SQLITE_CANTOPEN and dumped a raw stack
  // instead of the intended "didn't match any session" error.
  const root = mkdtempSync(join(tmpdir(), "ccs-resume-"));
  const bin = join(process.cwd(), "bin", "ccs");
  try {
    const p = Bun.spawn([bin, "resume", "nothing-matches-this-token"], {
      env: { ...process.env, CCS_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [rc, stderr] = await Promise.all([
      p.exited,
      new Response(p.stderr).text(),
    ]);
    expect(rc).toBe(1);
    // The intended user-facing message should appear; a raw SQLite stack must not.
    expect(stderr).toContain("didn't match any session");
    expect(stderr).not.toContain("SQLITE_CANTOPEN");
    expect(stderr).not.toContain("SQLiteError");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
