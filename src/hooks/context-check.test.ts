import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
});
