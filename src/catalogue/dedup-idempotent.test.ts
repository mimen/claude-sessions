/**
 * Acceptance criterion #10 (phase-1 hardening): the dedup-sessions-per-identity
 * script is idempotent under --apply. A second run against a freshly-deduped
 * catalogue must archive 0 sessions.
 *
 * The script is a top-level module that executes on import, so we drive it as
 * a subprocess against a scratch $CCS_ROOT with a seeded catalogue.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "./db.ts";
import { mintIdentity } from "./identities.ts";

const NOW_OLD = "2026-07-14T10:00:00Z";
const NOW_NEW = "2026-07-15T10:00:00Z";

async function runScript(root: string): Promise<{ rc: number; stdout: string; stderr: string }> {
  const bin = "bun";
  const script = join(process.cwd(), "scripts", "dedup-sessions-per-identity.ts");
  const p = Bun.spawn([bin, script, "--apply"], {
    env: { ...process.env, CCS_ROOT: root },
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

describe("dedup-sessions-per-identity idempotency (acceptance #10)", () => {
  test("2nd run on a freshly-deduped catalogue archives 0 sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-dedup-idem-"));
    try {
      mkdirSync(join(root, "cache"), { recursive: true });
      const dbPath = join(root, "cache", "catalogue.db");

      // Seed: one fleet identity attached to 3 sessions (2 old, 1 new).
      // Expected dedup: keep the newest, archive the 2 older.
      const db = openCatalogue(dbPath);
      const key = "pr-watch:pr-agent:owner/repo#42";
      mintIdentity(db, key, { cluster: "pr-watch", role: "pr-agent" }, NOW_OLD);
      const insert = db.query(
        "INSERT INTO catalogue (session_id, identity_key, updated_at) VALUES ($sid, $k, $now)",
      );
      insert.run({ $sid: "old-1", $k: key, $now: NOW_OLD });
      insert.run({ $sid: "old-2", $k: key, $now: NOW_OLD });
      insert.run({ $sid: "newest", $k: key, $now: NOW_NEW });
      db.close();

      // First run: archives the 2 older sessions.
      const first = await runScript(root);
      expect(first.rc).toBe(0);
      expect(first.stdout).toContain("Done: archived 2 session(s)");

      // Verify the state: 2 archived, 1 active.
      {
        const check = openCatalogue(dbPath);
        const archived = check.query("SELECT COUNT(*) as n FROM catalogue WHERE archived = 1").get() as {
          n: number;
        };
        const active = check.query("SELECT COUNT(*) as n FROM catalogue WHERE archived = 0").get() as {
          n: number;
        };
        expect(archived.n).toBe(2);
        expect(active.n).toBe(1);
        check.close();
      }

      // Second run: MUST be a no-op — archives 0.
      const second = await runScript(root);
      expect(second.rc).toBe(0);
      expect(second.stdout).toContain("Done: archived 0 session(s)");
      expect(second.stdout).toContain("sessions to archive:       0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
