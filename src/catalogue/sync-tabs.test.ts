/**
 * Acceptance criterion #12 (phase-1 hardening): `ccs sync-tabs --all` on the
 * live catalogue completes without spawning duplicate cmux tabs.
 *
 * The architectural guarantee: sync-tabs is PAINT-ONLY. It looks up each
 * session's live workspace via `workspaceForSession(sessionId)`, and if the
 * session isn't live (surface UUID not bound in cmux's hook store), it
 * returns `false` and skips. No tab is ever created — only painted.
 *
 * This test locks that in via a subprocess with a mkdtemp'd CCS_ROOT
 * seeded with a session, then confirms the CLI returns 0 with a
 * "not open / not synced" report — the intended shape when cmux has
 * no matching workspace to paint.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "./db.ts";

const NOW = "2026-07-15T00:00:00Z";

describe("sync-tabs paint-only guarantee (acceptance #12)", () => {
  test("--all on a catalogue with sessions cmux doesn't know: 0 synced, 0 spawned", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-synct-"));
    const bin = join(process.cwd(), "bin", "ccs");
    try {
      mkdirSync(join(root, "cache"), { recursive: true });
      const dbPath = join(root, "cache", "catalogue.db");
      // Seed the catalogue with one session. In this isolated env cmux
      // has no matching workspace ref, so paint MUST skip — no spawn.
      const db = openCatalogue(dbPath);
      db.query("INSERT INTO catalogue (session_id, updated_at) VALUES ('phantom-1', $now)").run({
        $now: NOW,
      });
      db.close();

      const p = Bun.spawn([bin, "sync-tabs", "--all"], {
        env: { ...process.env, CCS_ROOT: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [rc, stdout] = await Promise.all([
        p.exited,
        new Response(p.stdout).text(),
      ]);
      expect(rc).toBe(0);
      // Report shape: "synced N tab(s) (M not open / not synced)"
      expect(stdout).toMatch(/synced 0 tab\(s\) \(\d+ not open \/ not synced\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("sync-tabs on missing catalogue exits 1 with clear error (no spawn attempts)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-synct-empty-"));
    const bin = join(process.cwd(), "bin", "ccs");
    try {
      // Deliberately do NOT create cache/ dir — sync-tabs --all short-circuits.
      const p = Bun.spawn([bin, "sync-tabs", "--all"], {
        env: { ...process.env, CCS_ROOT: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [rc, stderr] = await Promise.all([
        p.exited,
        new Response(p.stderr).text(),
      ]);
      expect(rc).toBe(1);
      expect(stderr).toContain("No catalogue found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
