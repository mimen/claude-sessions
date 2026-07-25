import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bin/ccs --help module-loads under an isolated runtime root", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-cli-smoke-"));
  try {
    const result = Bun.spawnSync({
      cmd: [join(import.meta.dir, "..", "bin", "ccs"), "--help"],
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CCS_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const help = result.stdout.toString();
    expect(help).toContain("ccs — find and resume any Claude Code session");
    expect(help).toContain("ccs start [--] [text...]");
    expect(help).toContain("ccs location list|show|match|register|retire");
    expect(help).toContain("ccs finish-current <complete|archive> [--do]");
    expect(help).toContain("ccs close-current-workspace [--do]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bin/ccs routes finish-current to its deterministic argument parser", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-cli-finish-current-"));
  try {
    const result = Bun.spawnSync({
      cmd: [join(import.meta.dir, "..", "bin", "ccs"), "finish-current", "invalid"],
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CCS_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("usage: ccs finish-current <complete|archive> [--do]");
    expect(result.stderr.toString()).not.toContain("Unknown command");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ccs start --help describes the unsubmitted launcher shortcut without birthing", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-cli-start-help-"));
  try {
    const result = Bun.spawnSync({
      cmd: [join(import.meta.dir, "..", "bin", "ccs"), "start", "--help"],
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CCS_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("open a fresh launcher for /ccs:new");
    expect(result.stdout.toString()).toContain("never submits Enter");
    expect(existsSync(join(root, "cache", "catalogue.db"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ccs start clearly rejects obsolete inference flags without side effects", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-cli-start-obsolete-"));
  try {
    const result = Bun.spawnSync({
      cmd: [join(import.meta.dir, "..", "bin", "ccs"), "start", "--explain", "do", "work"],
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CCS_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("--explain is obsolete");
    expect(result.stderr.toString()).toContain("/ccs:new is the only router");
    expect(result.stdout.toString()).toBe("");
    expect(existsSync(join(root, "cache", "catalogue.db"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
