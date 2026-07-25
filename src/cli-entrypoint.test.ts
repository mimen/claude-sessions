import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
    const stdout = result.stdout.toString();
    expect(stdout).toContain("ccs — find and resume any Claude Code session");
    expect(stdout).toContain("ccs finish <sessionId> <complete|archive> [--do]");
    expect(stdout).toContain("ccs finish-current <complete|archive> [--do]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
