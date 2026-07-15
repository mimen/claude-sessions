/**
 * Acceptance criterion #11 (phase-1 hardening): backfill-identity-from-cwd
 * is idempotent under --apply. A second run must attach 0 additional sessions
 * because the script's `identity_key IS NULL` filter already excludes rows
 * touched by run 1.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openCatalogue } from "./db.ts";

const NOW = "2026-07-15T00:00:00Z";

async function runScript(root: string, configRoot: string): Promise<{ rc: number; stdout: string; stderr: string }> {
  const script = join(process.cwd(), "scripts", "backfill-identity-from-cwd.ts");
  const p = Bun.spawn(["bun", script, "--apply"], {
    env: { ...process.env, CCS_ROOT: root, CCS_CONFIG_ROOT: configRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [rc, stdout, stderr] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { rc, stdout, stderr };
}

describe("backfill-identity-from-cwd idempotency (acceptance #11)", () => {
  test("2nd run on a freshly-backfilled catalogue attaches 0 sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-bf-idem-"));
    const cfg = mkdtempSync(join(tmpdir(), "ccs-bf-cfg-"));
    try {
      mkdirSync(join(root, "cache"), { recursive: true });
      // Config tree with a core role.
      const roleDir = join(cfg, "clusters", "pr-watch", "roles", "concierge");
      mkdirSync(roleDir, { recursive: true });
      writeFileSync(join(roleDir, "role.toml"), 'kind = "loop"\nwork_unit = "none"\n');

      // Prime the index and catalogue with a session whose cwd is under the role dir.
      const idxPath = join(root, "cache", "index.db");
      const catPath = join(root, "cache", "catalogue.db");

      // Import openIndex to create the schema in the same shape the script expects.
      const { openIndex } = await import("../index/schema.ts");
      const idx = openIndex(idxPath);
      idx.query(
        `INSERT INTO sessions (session_id, host, path, cwd, project_root, project_name,
           fallback_label, first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id)
         VALUES ($sid, 'h', $path, $cwd, $cwd, 'p', 'x', $now, $now, 1, 0, 0, 0, $sid)`,
      ).run({
        $sid: "sid-1",
        $path: "/store/sid-1.jsonl",
        $cwd: roleDir,
        $now: NOW,
      });
      idx.close();

      // Create a NULL-identity catalogue row for that session (the state the script targets).
      const cat = openCatalogue(catPath);
      cat.query("INSERT INTO catalogue (session_id, updated_at) VALUES ($sid, $now)").run({
        $sid: "sid-1",
        $now: NOW,
      });
      cat.close();

      // First run: attaches the session to `pr-watch:concierge` and mints the identity.
      const first = await runScript(root, cfg);
      expect(first.rc).toBe(0);
      expect(first.stdout).toContain("sessions attached:        1");

      // Verify the state landed.
      {
        const check = openCatalogue(catPath);
        const row = check.query("SELECT identity_key FROM catalogue WHERE session_id = 'sid-1'").get() as {
          identity_key: string | null;
        };
        expect(row.identity_key).toBe("pr-watch:concierge");
        check.close();
      }

      // Second run: MUST be a no-op — nothing to attach because the session
      // is no longer NULL-identity.
      const second = await runScript(root, cfg);
      expect(second.rc).toBe(0);
      expect(second.stdout).toContain("sessions needing attach:  0");
      expect(second.stdout).toContain("sessions attached:        0");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cfg, { recursive: true, force: true });
    }
  }, 30_000);
});
