import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, getRow, _resetRoleResumeCache } from "./db.ts";
import { mintIdentity } from "./identities.ts";

const NOW = "2026-07-09T00:00:00Z";

const cfgs: string[] = [];
afterEach(() => {
  for (const d of cfgs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.CCS_CONFIG_ROOT;
  _resetRoleResumeCache();
});

/** Write a role.toml under a temp config root and point CCS_CONFIG_ROOT at it. */
function withRole(cluster: string, role: string, toml: string): void {
  const root = mkdtempSync(join(tmpdir(), "ccs-role-"));
  cfgs.push(root);
  const dir = join(root, "clusters", cluster, "roles", role);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.toml"), toml);
  process.env.CCS_CONFIG_ROOT = root;
}

/** Post-ADR-0089: attach a session to an identity via the identity table + FK. */
function seed(db: import("bun:sqlite").Database, sid: string, cluster: string, role: string): string {
  const key = `${cluster}:${role}`;
  mintIdentity(db, key, { cluster, role }, NOW);
  db.query(
    `INSERT INTO catalogue (session_id, identity_key, updated_at) VALUES ($sid, $k, $now)
     ON CONFLICT(session_id) DO UPDATE SET identity_key = $k, updated_at = $now`,
  ).run({ $sid: sid, $k: key, $now: NOW });
  return key;
}

test("role reflects the linked identity's role", () => {
  const db = openCatalogue(":memory:");
  seed(db, "s1", "pr-watch", "pr-agent");
  expect(getRow(db, "s1")!.role).toBe("pr-agent");
});

test("resume_command + kind DERIVE from the role's role.toml (ADR-0062)", () => {
  withRole("pr-watch", "control", 'resume_command = "/loop 15m /pr-watch-control"\nwork_unit = "none"\n');
  const db = openCatalogue(":memory:");
  seed(db, "ctrl", "pr-watch", "control");
  const row = getRow(db, "ctrl")!;
  expect(row.resumeCommand).toBe("/loop 15m /pr-watch-control");
  expect(row.kind).toBe("loop");
});

test("a role with no resume_command derives kind 'session'", () => {
  withRole("pr-watch", "pr-agent", 'work_unit = "pr"\n');
  const db = openCatalogue(":memory:");
  seed(db, "w", "pr-watch", "pr-agent");
  const row = getRow(db, "w")!;
  expect(row.resumeCommand).toBeNull();
  expect(row.kind).toBe("session");
});
