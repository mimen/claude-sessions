/**
 * Acceptance criterion #4 (phase-1 hardening): the full session lifecycle
 * round-trip works end-to-end through the CLI verbs — `identity mint`,
 * `session set --identity`, `session complete`, `session archive`,
 * `session unarchive` — and `identity ls` (via listIdentities) reflects
 * the resulting state at every step.
 *
 * This is the load-bearing integration path for every worker session in
 * the fleet, so it deserves an explicit locked-in trace.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "./db.ts";
import { getIdentity, listIdentities, mintIdentity } from "./identities.ts";
import { sessionCommand } from "./session-command.ts";

const NOW = "2026-07-15T00:00:00Z";

async function withRoot(fn: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ccs-rt-"));
  const prev = process.env.CCS_ROOT;
  process.env.CCS_ROOT = root;
  mkdirSync(join(root, "cache"), { recursive: true });
  try {
    await fn(root);
  } finally {
    prev === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = prev);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("lifecycle round-trip (acceptance #4)", () => {
  test("mint → attach → complete → archive → unarchive; state visible on identity + session at every step", async () => {
    await withRoot(async (root) => {
      const dbPath = join(root, "cache", "catalogue.db");
      const setup = openCatalogue(dbPath);
      // Step 1 — mint the identity. `identity ls` shows it with completed=archived=false.
      const key = "pr-watch:pr-agent:owner/repo#12080";
      expect(mintIdentity(setup, key, { cluster: "pr-watch", role: "pr-agent" }, NOW)).toBe(true);
      // Seed a session row (would normally happen via newSession); we'll attach it next.
      const sid = "2ed1df23-e1d3-4381-b285-bad39a4f5c00";
      setup.query("INSERT INTO catalogue (session_id, updated_at) VALUES ($sid, $now)").run({
        $sid: sid,
        $now: NOW,
      });
      setup.close();

      // ls reflects the mint
      const dbLs1 = openCatalogue(dbPath);
      expect(listIdentities(dbLs1, { cluster: "pr-watch" }).length).toBe(1);
      dbLs1.close();

      // Step 2 — session set --identity= attaches the session
      expect(await sessionCommand(["set", sid, `--identity=${key}`])).toBe(0);
      {
        const db = openCatalogue(dbPath);
        const row = db
          .query("SELECT identity_key FROM catalogue WHERE session_id = $sid")
          .get({ $sid: sid }) as { identity_key: string | null };
        expect(row.identity_key).toBe(key);
        db.close();
      }

      // Step 3 — session complete flips the session AND (fleet-mirror) the identity
      expect(await sessionCommand(["complete", sid])).toBe(0);
      {
        const db = openCatalogue(dbPath);
        const srow = db
          .query("SELECT completed, archived FROM catalogue WHERE session_id = $sid")
          .get({ $sid: sid }) as { completed: number; archived: number };
        expect(srow.completed).toBe(1);
        expect(srow.archived).toBe(0);
        // Fleet mirror: identity is now completed too.
        const id = getIdentity(db, key)!;
        expect(id.completed).toBe(true);
        expect(id.archived).toBe(false);
        // ls with completed filter surfaces it
        expect(listIdentities(db, { completed: true }).map((i) => i.identityKey)).toContain(key);
        db.close();
      }

      // Step 4 — session archive additionally flips archived
      expect(await sessionCommand(["archive", sid])).toBe(0);
      {
        const db = openCatalogue(dbPath);
        const srow = db
          .query("SELECT completed, archived FROM catalogue WHERE session_id = $sid")
          .get({ $sid: sid }) as { completed: number; archived: number };
        expect(srow.completed).toBe(1);
        expect(srow.archived).toBe(1);
        const id = getIdentity(db, key)!;
        expect(id.archived).toBe(true);
        expect(listIdentities(db, { archived: true }).map((i) => i.identityKey)).toContain(key);
        db.close();
      }

      // Step 5 — session unarchive flips archived back to 0; completed stays 1
      expect(await sessionCommand(["unarchive", sid])).toBe(0);
      {
        const db = openCatalogue(dbPath);
        const srow = db
          .query("SELECT completed, archived FROM catalogue WHERE session_id = $sid")
          .get({ $sid: sid }) as { completed: number; archived: number };
        expect(srow.completed).toBe(1);
        expect(srow.archived).toBe(0);
        const id = getIdentity(db, key)!;
        expect(id.archived).toBe(false);
        expect(id.completed).toBe(true); // untouched
        // ls filters reflect the current state
        expect(listIdentities(db, { archived: true }).map((i) => i.identityKey)).not.toContain(key);
        expect(listIdentities(db, { completed: true }).map((i) => i.identityKey)).toContain(key);
        db.close();
      }
    });
  });

  // Acceptance #7: session-level `archive` on a CORE identity's session must NOT
  // flip the identity itself. Core identities (concierge, control, …) are
  // long-lived across many session lifetimes; archiving one session must stay
  // per-session or every peer session attached to the same core identity gets
  // hidden. The mirror at commands.ts:76 gates lifecycle on identity kind for
  // this reason. This test drives the whole CLI verb through sessionCommand.
  test("session archive on a CORE identity's session leaves identity.archived=0", async () => {
    await withRoot(async (root) => {
      const dbPath = join(root, "cache", "catalogue.db");
      const setup = openCatalogue(dbPath);
      const key = "pr-watch:control"; // 2-part key = core (per key-shape derivation)
      expect(mintIdentity(setup, key, { cluster: "pr-watch", role: "control" }, NOW)).toBe(true);
      const sid = "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e";
      setup.query("INSERT INTO catalogue (session_id, identity_key, updated_at) VALUES ($sid, $k, $now)").run({
        $sid: sid,
        $k: key,
        $now: NOW,
      });
      setup.close();

      // session archive: flips the session's archived flag, but the mirror
      // must skip lifecycle for core identities.
      expect(await sessionCommand(["archive", sid])).toBe(0);
      const db = openCatalogue(dbPath);
      const srow = db
        .query("SELECT archived FROM catalogue WHERE session_id = $sid")
        .get({ $sid: sid }) as { archived: number };
      expect(srow.archived).toBe(1); // session-level: archived
      const id = getIdentity(db, key)!;
      expect(id.archived).toBe(false); // identity: NOT archived — the load-bearing assertion
      db.close();
    });
  });

  // Companion to #7: on a FLEET identity the mirror DOES cascade — a fleet
  // identity is 1:1 with its work unit, so a session-level completion (the
  // retire path) is the right signal to also complete the identity. Locks
  // the split against a future 'tidy up, mirror everything' change.
  test("session complete on a FLEET identity's session cascades to identity.completed", async () => {
    await withRoot(async (root) => {
      const dbPath = join(root, "cache", "catalogue.db");
      const setup = openCatalogue(dbPath);
      const key = "pr-watch:pr-agent:owner/repo#42"; // 3-part = fleet
      expect(mintIdentity(setup, key, { cluster: "pr-watch", role: "pr-agent" }, NOW)).toBe(true);
      const sid = "2f2f2f2f-2f2f-4f2f-8f2f-2f2f2f2f2f2f";
      setup.query("INSERT INTO catalogue (session_id, identity_key, updated_at) VALUES ($sid, $k, $now)").run({
        $sid: sid,
        $k: key,
        $now: NOW,
      });
      setup.close();

      expect(await sessionCommand(["complete", sid])).toBe(0);
      const db = openCatalogue(dbPath);
      const id = getIdentity(db, key)!;
      expect(id.completed).toBe(true); // fleet cascade
      db.close();
    });
  });
});
