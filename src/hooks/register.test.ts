import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, getRow, _resetRoleResumeCache } from "../catalogue/db.ts";
import { mintIdentity } from "../catalogue/identities.ts";
import { handleSessionStart } from "./register.ts";

const NOW = "2026-07-09T00:00:00Z";

const cfgs: string[] = [];
afterEach(() => {
  for (const d of cfgs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.CCS_CONFIG_ROOT;
  _resetRoleResumeCache();
});
function withControlLoop(): void {
  const root = mkdtempSync(join(tmpdir(), "ccs-reg-"));
  cfgs.push(root);
  const dir = join(root, "clusters", "pr-watch", "roles", "control");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.toml"), 'resume_command = "/loop 15m /pr-watch-control"\nwork_unit = "none"\n');
  process.env.CCS_CONFIG_ROOT = root;
}

/** Post-ADR-0089: seed a session with an identity linked in one shot. */
function attach(db: import("bun:sqlite").Database, sid: string, cluster: string, role: string, now = NOW): void {
  const key = `${cluster}:${role}`;
  mintIdentity(db, key, { cluster, role }, now);
  db.query(
    `INSERT INTO catalogue (session_id, identity_key, updated_at) VALUES ($sid, $k, $now)
     ON CONFLICT(session_id) DO UPDATE SET identity_key = $k, updated_at = $now`,
  ).run({ $sid: sid, $k: key, $now: now });
}

describe("handleSessionStart", () => {
  test("registered session: refreshed silently, no additionalContext", () => {
    const db = openCatalogue(":memory:");
    attach(db, "s1", "pr-watch", "pr-agent");
    const out = handleSessionStart(db, { session_id: "s1", source: "startup", cwd: "/x" }, NOW);
    expect(out.registered).toBe(true);
    expect(out.additionalContext).toBeNull();
    expect(out.degraded).toBe(false);
  });

  test("unregistered session: emits additionalContext asking the agent to self-register", () => {
    const db = openCatalogue(":memory:");
    const out = handleSessionStart(db, { session_id: "new", source: "startup", cwd: "/x" }, NOW);
    expect(out.registered).toBe(false);
    expect(out.additionalContext).toContain("ccs role");
    expect(out.degraded).toBe(true);
  });

  test("registration touches updated_at on a known session (refresh)", () => {
    const db = openCatalogue(":memory:");
    attach(db, "s1", "pr-watch", "control", "2026-07-01T00:00:00Z");
    handleSessionStart(db, { session_id: "s1", source: "startup", cwd: "/x" }, NOW);
    expect(getRow(db, "s1")!.updatedAt).toBe(NOW);
  });

  test("re-arm: a resumed loop (role declares resume_command) is flagged for re-arming", () => {
    withControlLoop();
    const db = openCatalogue(":memory:");
    attach(db, "loop", "pr-watch", "control");
    const out = handleSessionStart(db, { session_id: "loop", source: "resume", cwd: "/x" }, NOW);
    expect(out.reArm).toBe("/loop 15m /pr-watch-control");
    expect(out.additionalContext).toContain("/loop 15m /pr-watch-control");
  });

  test("no re-arm on a fresh (startup) start, even for a loop role", () => {
    withControlLoop();
    const db = openCatalogue(":memory:");
    attach(db, "loop", "pr-watch", "control");
    const out = handleSessionStart(db, { session_id: "loop", source: "startup", cwd: "/x" }, NOW);
    expect(out.reArm).toBeNull();
  });

  test("a worker resume (no resume_command) does not re-arm", () => {
    const db = openCatalogue(":memory:");
    attach(db, "w", "pr-watch", "pr-agent");
    const out = handleSessionStart(db, { session_id: "w", source: "resume", cwd: "/x" }, NOW);
    expect(out.reArm).toBeNull();
  });

  test("a malformed payload (no session_id) fails open — no throw, degraded", () => {
    const db = openCatalogue(":memory:");
    const out = handleSessionStart(db, { source: "startup" } as never, NOW);
    expect(out.registered).toBe(false);
    expect(out.degraded).toBe(true);
    expect(out.additionalContext).toBeNull();
  });
});
