import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression: `ccs context-check` on a fresh CCS_ROOT (no ~/.ccs/cache/index.db)
 * previously threw SQLITE_CANTOPEN because findTranscriptPath opened the index
 * unconditionally. The command's exit code was still 0 (bug: the throw
 * escaped into user-visible stderr), but the stack trace looked broken.
 *
 * Fix: guard the open with existsSync(DB_PATH()). Now the command reports
 * a clean UNKNOWN + "transcript not found" directive.
 */
describe("ccs context-check on fresh CCS_ROOT", () => {
  test("no ~/.ccs/cache/index.db → clean UNKNOWN output, no SQLite stack trace", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-cxc-"));
    const bin = join(process.cwd(), "bin", "ccs");
    try {
      const p = Bun.spawn([bin, "context-check", "--json"], {
        env: {
          ...process.env,
          CCS_ROOT: root,
          CLAUDE_CODE_SESSION_ID: "abc-defg-hijk",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [rc, stdout, stderr] = await Promise.all([
        p.exited,
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      expect(rc).toBe(0);
      expect(stderr).not.toContain("SQLITE_CANTOPEN");
      expect(stderr).not.toContain("SQLiteError");
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe("UNKNOWN");
      expect(parsed.transcript).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unindexed live session → reads the transcript from ~/.claude/projects", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-cxc-"));
    const home = mkdtempSync(join(tmpdir(), "ccs-cxc-home-"));
    const id = "11111111-2222-3333-4444-555555555555";
    const folder = join(home, ".claude", "projects", "-tmp-x");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${id}.jsonl`), JSON.stringify({ message: { usage: { input_tokens: 100_000 } } }) + "\n");
    try {
      const p = Bun.spawn([join(process.cwd(), "bin", "ccs"), "context-check", "--json"], {
        env: { ...process.env, CCS_ROOT: root, HOME: home, CLAUDE_CODE_SESSION_ID: id },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [rc, stdout] = await Promise.all([p.exited, new Response(p.stdout).text()]);
      expect(rc).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.status).toBe("OK");
      expect(parsed.tokens).toBe(100_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
