import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCatalogue,
  getRow,
  setRole,
  _resetRoleResumeCache,
} from "./db.ts";

const NOW = "2026-07-09T00:00:00Z";

const cfgs: string[] = [];
afterEach(() => {
  for (const d of cfgs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.CCS_CONFIG_ROOT;
  _resetRoleResumeCache(); // cache is keyed by role name — clear between temp config roots
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

test("role is a first-class column, set + round-trips", () => {
  const db = openCatalogue(":memory:");
  setRole(db, "s1", "pr-agent", NOW);
  expect(getRow(db, "s1")!.role).toBe("pr-agent");
});

test("resume_command + kind DERIVE from the role's role.toml (ADR-0062), not a stored column", () => {
  // A role that declares a resume_command IS a loop; its sessions read that resumeCommand + kind.
  withRole("pr-watch", "control", 'resume_command = "/loop 15m /pr-watch-control"\nwork_unit = "none"\n');
  const db = openCatalogue(":memory:");
  setRole(db, "ctrl", "control", NOW);
  const row = getRow(db, "ctrl")!;
  expect(row.resumeCommand).toBe("/loop 15m /pr-watch-control");
  expect(row.kind).toBe("loop");
});

test("a role with no resume_command derives kind 'session'", () => {
  withRole("pr-watch", "pr-agent", 'work_unit = "pr"\n');
  const db = openCatalogue(":memory:");
  setRole(db, "w", "pr-agent", NOW);
  const row = getRow(db, "w")!;
  expect(row.resumeCommand).toBeNull();
  expect(row.kind).toBe("session");
});
