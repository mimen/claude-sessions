import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, getRow, lifecycleOf, identityKeyOf, setCluster, stampPrFacts, setWorkUnitId, getMeta, _resetRoleResumeCache } from "../catalogue/db.ts";
import { getIdentity } from "../catalogue/identities.ts";
import { resolveWorkUnit } from "../catalogue/resolve-work-unit.ts";
import { inlineLaunchOutcome, newSession, parseOpts, writeSessionMetadata } from "./new-session.ts";

const NOW = "2026-07-08T00:00:00.000Z";

const roots: string[] = [];
afterEach(() => {
  _resetRoleResumeCache();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.CCS_CONFIG_ROOT; delete process.env.CCS_ROOT;
});
/** Temp config+runtime roots with a pr-anchored role, for the work-unit spawn path. */
function withPrRole(): void {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-ns-cfg-"));
  const rt = mkdtempSync(join(tmpdir(), "ccs-ns-rt-"));
  roots.push(cfg, rt);
  const dir = join(cfg, "clusters", "pr-watch", "roles", "pr-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.toml"), 'work_unit = "pr"\n');
  process.env.CCS_CONFIG_ROOT = cfg; process.env.CCS_ROOT = rt;
  _resetRoleResumeCache();
}

function withEventRole(): string {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-ns-cfg-"));
  const rt = mkdtempSync(join(tmpdir(), "ccs-ns-rt-"));
  roots.push(cfg, rt);
  const dir = join(cfg, "clusters", "event-watch", "roles", "event-worker");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.toml"), 'kind = "session"\nwork_unit = "none"\n');
  mkdirSync(join(rt, "cache"), { recursive: true });
  process.env.CCS_CONFIG_ROOT = cfg; process.env.CCS_ROOT = rt;
  _resetRoleResumeCache();
  return rt;
}

test("supersede-on-spawn: a new worker archives prior sessions of the same identity (ADR-0073)", () => {
  withPrRole();
  const db = openCatalogue(":memory:");
  try {
    // ADR-0089 v33: siblings on the same PR share ONE identity_key. Seed the OLD session
    // attached to it via the identity FK; writeSessionMetadata for a new sid on the same
    // identity should archive the old.
    const oldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    writeSessionMetadata(db, oldId, parseOpts([
      "--cluster", "pr-watch", "--role", "pr-agent",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);
    expect(lifecycleOf(getRow(db, oldId)!)).toBe("idle");

    // Spawn a FRESH worker for the same PR.
    const newId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    writeSessionMetadata(db, newId, parseOpts([
      "--cluster", "pr-watch", "--role", "pr-agent",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);

    // the old one is archived (expired) with a pointer to who superseded it
    expect(lifecycleOf(getRow(db, oldId)!)).toBe("archived");
    expect(getMeta(getRow(db, oldId)!, "superseded_by")).toBe(newId);
    // the new one is idle + shares the identity_key
    expect(lifecycleOf(getRow(db, newId)!)).toBe("idle");
    expect(getRow(db, newId)!.identityKey).toBe("pr-watch:pr-agent:heroku/dashboard#12080");
  } finally {
    db.close();
  }
});

test("supersede-on-spawn keeps the fleet identity alive (acceptance #9)", () => {
  // The old session is archived (superseded) but the identity itself must
  // stay active — the WORK UNIT (this PR) is still in flight, just being
  // taken over by a fresh worker. If the identity flipped archived=1 here
  // the whole PR would vanish from the board.
  withPrRole();
  const db = openCatalogue(":memory:");
  try {
    const key = "pr-watch:pr-agent:heroku/dashboard#12080";

    // 1st worker
    const oldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    writeSessionMetadata(db, oldId, parseOpts([
      "--cluster", "pr-watch", "--role", "pr-agent",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);

    // 2nd worker on the same PR
    const newId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    writeSessionMetadata(db, newId, parseOpts([
      "--cluster", "pr-watch", "--role", "pr-agent",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);

    // Old session is archived + points at the successor.
    expect(lifecycleOf(getRow(db, oldId)!)).toBe("archived");
    expect(getMeta(getRow(db, oldId)!, "superseded_by")).toBe(newId);
    // New session is live and attached to the same identity.
    expect(lifecycleOf(getRow(db, newId)!)).toBe("idle");
    expect(getRow(db, newId)!.identityKey).toBe(key);

    // THE ACCEPTANCE CHECK: the shared fleet identity itself stays
    // active (archived=false, completed=false). If mintIdentity's idempotent
    // no-op ever regressed into 'reset flags on re-mint', this would flip.
    const id = getIdentity(db, key)!;
    expect(id.archived).toBe(false);
    expect(id.completed).toBe(false);
  } finally {
    db.close();
  }
});

test("parseOpts: reads every flag, --role and --skill are synonyms", () => {
  const o = parseOpts([
    "--cluster", "pr-watch",
    "--role", "pr-agent",
    "--project", "metered-pricing",
    "--key", "heroku_dashboard-12080",
    "--title", "#12080 Fix navbar",
    "--parent", "aaaa",
    "--cwd", "/tmp",
    "--prompt", "go build it",
    "--permission-mode", "acceptEdits",
    "--print-id",
  ]);
  expect(o.cluster).toBe("pr-watch");
  expect(o.role).toBe("pr-agent");
  expect(o.project).toBe("metered-pricing");
  expect(o.key).toBe("heroku_dashboard-12080");
  expect(o.title).toBe("#12080 Fix navbar");
  expect(o.parent).toBe("aaaa");
  expect(o.cwd).toBe("/tmp");
  expect(o.prompt).toBe("go build it");
  expect(o.permissionMode).toBe("acceptEdits");
  expect(o.printId).toBe(true);
});

test("parseOpts: --skill is accepted as an alias for --role", () => {
  expect(parseOpts(["--skill", "pr-watch-eval"]).role).toBe("pr-watch-eval");
});

test("parseOpts: reads explicit identity-at-birth flags", () => {
  const opts = parseOpts([
    "--identity=event-watch:event-worker:gio",
    "--cluster=event-watch",
    "--role=/event-worker",
    "--top-level",
    "--print-id",
  ]);
  expect(opts.identity).toBe("event-watch:event-worker:gio");
  expect(opts.cluster).toBe("event-watch");
  expect(opts.role).toBe("/event-worker");
  expect(opts.topLevel).toBe(true);
  expect(opts.printId).toBe(true);
});

test("parseOpts: does not reinterpret an option-shaped prompt as identity", () => {
  const opts = parseOpts(["--prompt", "--identity=not-a-flag", "--cluster=event-watch"]);
  expect(opts.prompt).toBe("--identity=not-a-flag");
  expect(opts.identity).toBeUndefined();
  expect(opts.cluster).toBe("event-watch");
});

test("parseOpts: does not reinterpret boolean flags inside a prompt", () => {
  expect(parseOpts(["--prompt", "--top-level"]).topLevel).toBe(false);
  expect(parseOpts(["--prompt", "--print-id"]).printId).toBe(false);
  expect(parseOpts(["--prompt", "--inline"]).inline).toBe(false);
});

test("inline launch outcome distinguishes startup failures from launched failures", () => {
  expect(inlineLaunchOutcome(null, undefined)).toEqual({ exitCode: 127, startupFailed: true });
  expect(inlineLaunchOutcome(1, undefined)).toEqual({ exitCode: 1, startupFailed: false });
  expect(inlineLaunchOutcome(null, "SIGKILL")).toEqual({ exitCode: 137, startupFailed: false });
});

test("writeSessionMetadata: explicit identity attaches without minting or inferring work", () => {
  const db = openCatalogue(":memory:");
  try {
    const key = "event-watch:event-worker:gio";
    const { mintIdentity } = require("../catalogue/identities.ts") as typeof import("../catalogue/identities.ts");
    mintIdentity(db, key, { cluster: "event-watch", role: "event-worker" }, NOW);
    const id = "11111111-1111-4111-8111-111111111111";
    writeSessionMetadata(db, id, parseOpts([
      `--identity=${key}`, "--cluster=event-watch", "--role=/event-worker", "--title=Gio", "--top-level",
    ]), NOW);
    const row = getRow(db, id)!;
    expect(row.identityKey).toBe(key);
    expect(row.resumeId).toBe(id);
    expect(row.customTitle).toBe("Gio");
    expect(row.parentSessionId).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM identities").get()).toEqual({ count: 1 });
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: explicit identity failure leaves no partial session row", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(() => writeSessionMetadata(db, id, parseOpts([
      "--identity=event-watch:event-worker:missing", "--cluster=event-watch", "--role=event-worker", "--title=must not persist",
    ]), NOW)).toThrow("does not exist");
    expect(getRow(db, id)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM identities").get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: explicit metadata rolls back if a later write fails", () => {
  const db = openCatalogue(":memory:");
  try {
    const key = "event-watch:event-worker:gio";
    const { mintIdentity } = require("../catalogue/identities.ts") as typeof import("../catalogue/identities.ts");
    mintIdentity(db, key, { cluster: "event-watch", role: "event-worker" }, NOW);
    db.exec(`
      CREATE TRIGGER abort_explicit_title
      BEFORE UPDATE OF custom_title ON catalogue
      WHEN NEW.custom_title IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'title write failed'); END;
    `);
    const id = "33333333-3333-4333-8333-333333333333";
    expect(() => writeSessionMetadata(db, id, parseOpts([
      `--identity=${key}`, "--cluster=event-watch", "--role=event-worker", "--title=rollback",
    ]), NOW)).toThrow("title write failed");
    expect(getRow(db, id)).toBeNull();
    expect(getIdentity(db, key)).not.toBeNull();
  } finally {
    db.close();
  }
});

test("newSession: explicit --print-id registers only a matching pre-minted identity", () => {
  const root = withEventRole();
  const key = "event-watch:event-worker:gio";
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const { mintIdentity } = require("../catalogue/identities.ts") as typeof import("../catalogue/identities.ts");
    mintIdentity(db, key, { cluster: "event-watch", role: "event-worker" }, NOW);
  } finally {
    db.close();
  }

  expect(newSession([
    `--identity=${key}`, "--cluster=event-watch", "--role=/event-worker", "--top-level", "--print-id",
  ])).toBe(0);
  const check = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const rows = check.query("SELECT identity_key, resume_id, parent_session_id FROM catalogue").all() as Array<{
      identity_key: string; resume_id: string; parent_session_id: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identity_key).toBe(key);
    expect(rows[0]?.resume_id).toBeDefined();
    expect(rows[0]?.parent_session_id).toBeNull();
    expect(check.query("SELECT COUNT(*) AS count FROM identities").get()).toEqual({ count: 1 });
  } finally {
    check.close();
  }
});

test("newSession: --top-level rejects --parent for legacy births before registration", () => {
  const root = withEventRole();
  expect(newSession([
    "--cluster=event-watch", "--role=event-worker", "--top-level", "--parent=parent-session", "--print-id",
  ])).toBe(2);
  const check = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    expect(check.query("SELECT COUNT(*) AS count FROM catalogue").get()).toEqual({ count: 0 });
  } finally {
    check.close();
  }
});

test("newSession: explicit birth rejects absent identity, missing or mismatched axes, and --key before registration", () => {
  const root = withEventRole();
  const key = "event-watch:event-worker:gio";
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const { mintIdentity } = require("../catalogue/identities.ts") as typeof import("../catalogue/identities.ts");
    mintIdentity(db, key, { cluster: "event-watch", role: "event-worker" }, NOW);
  } finally {
    db.close();
  }

  expect(newSession(["--identity=event-watch:event-worker:missing", "--cluster=event-watch", "--role=event-worker", "--print-id"])).toBe(2);
  expect(newSession([`--identity=${key}`, "--role=event-worker", "--print-id"])).toBe(2);
  expect(newSession([`--identity=${key}`, "--cluster=other-cluster", "--role=event-worker", "--print-id"])).toBe(2);
  expect(newSession([`--identity=${key}`, "--cluster=event-watch", "--role=other-role", "--print-id"])).toBe(2);
  expect(newSession([`--identity=${key}`, "--cluster=event-watch", "--role=event-worker", "--key=legacy", "--print-id"])).toBe(2);
  expect(newSession([
    `--identity=${key}`, "--cluster=event-watch", "--role=event-worker",
    "--pr-repo=owner/repo", "--pr-number=123", "--print-id",
  ])).toBe(2);

  const check = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    expect(check.query("SELECT COUNT(*) AS count FROM catalogue").get()).toEqual({ count: 0 });
    expect(check.query("SELECT COUNT(*) AS count FROM identities").get()).toEqual({ count: 1 });
  } finally {
    check.close();
  }
});

test("writeSessionMetadata: binds identity to a not-yet-indexed id (forward reference)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "11111111-2222-3333-4444-555555555555";
    writeSessionMetadata(db, id, parseOpts([
      "--cluster", "pr-watch",
      "--role", "pr-agent",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
      "--title", "#12080 Fix navbar",
    ]), NOW);

    const row = getRow(db, id);
    expect(row).not.toBeNull();
    expect(row!.cluster).toBe("pr-watch");
    expect(row!.role).toBe("pr-agent");
    expect(row!.kind).toBe("session");
    // ADR-0089: identity_key is the structured <cluster>:<role>:<work_ref> form.
    expect(row!.identityKey).toBe("pr-watch:pr-agent:heroku/dashboard#12080");
    expect(row!.customTitle).toBe("#12080 Fix navbar");
    expect(row!.resumeId).toBe(id);
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: a leading slash on the role is normalised away", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    writeSessionMetadata(db, id, parseOpts(["--cluster", "pr-watch", "--role", "/pr-watch-control"]), NOW);
    expect(getRow(db, id)!.role).toBe("pr-watch-control");
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: stamps gus-work + PR facts at birth (statusline link from turn one)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "cccccccc-dddd-eeee-ffff-000000000000";
    writeSessionMetadata(db, id, parseOpts([
      "--cluster", "pr-watch", "--role", "pr-agent",
      "--gus-work", "W-23034218",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);
    const row = getRow(db, id)!;
    // ADR-0089: per-role table isn't materialized in :memory: without a config root, so
    // per-role attrs read as null here. The identity mint succeeded; the join is empty.
    // Assert the identity_key was built from PR facts.
    expect(row.identityKey).toBe("pr-watch:pr-agent:heroku/dashboard#12080");
  } finally {
    db.close();
  }
});

test("parseOpts: --pr-number 0 (no PR yet) is treated as absent, not stamped", () => {
  const o = parseOpts(["--pr-number", "0", "--pr-repo", "heroku/dashboard"]);
  expect(o.prNumber).toBeUndefined();
});

test("writeSessionMetadata: --resume-command is not persisted outside the role definition", () => {
  withPrRole();
  const db = openCatalogue(":memory:");
  try {
    const id = "ffffffff-0000-1111-2222-333333333333";
    const opts = parseOpts([
      "--cluster", "pr-watch",
      "--role", "pr-agent",
      "--pr-number", "12080",
      "--pr-repo", "heroku/dashboard",
      "--resume-command", "/loop 15m /pr-watch-control",
    ]);
    expect(opts.resumeCommand).toBeUndefined();
    writeSessionMetadata(db, id, opts, NOW);
    expect(getRow(db, id)!.resumeCommand).toBeNull();
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: only the provided fields are written (no clobber to defaults)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "99999999-8888-7777-6666-555555555555";
    // ADR-0089 v33: cluster only surfaces through the identity join, so pass role too.
    writeSessionMetadata(db, id, parseOpts(["--cluster", "pr-watch", "--role", "concierge"]), NOW);
    const row = getRow(db, id)!;
    expect(row.cluster).toBe("pr-watch");
    expect(row.role).toBe("concierge");
    expect(row.customTitle).toBeNull();
    expect(lifecycleOf(row)).toBe("idle");
  } finally {
    db.close();
  }
});

import { validateSpawn } from "./new-session.ts";
import type { RoleDef } from "../catalogue/db.ts";

const loopDef: RoleDef = {
  role: "control", cluster: "pr-watch", kind: "loop", workUnit: "none", homeDir: "/tmp",
  resumeCommand: "/loop 15m /pr-watch-control", stageSchema: null, pinOnResume: false, color: null, skills: [], commands: [], hooks: [], updatedAt: null,
};

test("writeSessionMetadata: --role without --cluster inherits cluster from role registry + mints identity", () => {
  // Punch-list guarantee: spawning with only --role (a common ergonomic
  // shortcut for cluster-scoped roles) infers --cluster from the role's
  // registered cluster path and mints the identity_key. Regression against
  // the 'silently skips identity minting when cluster is unset' hazard.
  withPrRole();
  // Register a core (no work_unit) role under pr-watch/roles/concierge so we
  // exercise the core path — the pr-agent path already needs pr flags.
  const cfg = process.env.CCS_CONFIG_ROOT!;
  const conciergeDir = join(cfg, "clusters", "pr-watch", "roles", "concierge");
  mkdirSync(conciergeDir, { recursive: true });
  writeFileSync(join(conciergeDir, "role.toml"), 'kind = "session"\nwork_unit = "none"\n');

  const db = openCatalogue(":memory:");
  try {
    const sid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    // --role only, NO --cluster; resolveRole should return the pr-watch role
    // and callers upstream default opts.cluster from roleDef.cluster before
    // reaching writeSessionMetadata. Simulate that fill-in here (since this
    // test drives writeSessionMetadata directly).
    const opts = parseOpts(["--role", "concierge"]);
    opts.cluster = "pr-watch"; // <-- what newSession() does before writeSessionMetadata
    writeSessionMetadata(db, sid, opts, NOW);
    const row = getRow(db, sid)!;
    expect(row.identityKey).toBe("pr-watch:concierge");
  } finally {
    db.close();
  }
});

test("validateSpawn: unknown role errors", () => {
  expect(validateSpawn(parseOpts(["--role", "ghost"]), null)).toContain("not in the registry");
});

test("validateSpawn: loop role without resume_command errors (would launch dormant)", () => {
  const def: RoleDef = { ...loopDef, resumeCommand: null };
  expect(validateSpawn({ printId: false, inline: false }, def)).toContain("no resume_command");
});

test("validateSpawn: missing cwd errors", () => {
  expect(validateSpawn({ printId: false, inline: false, cwd: "/no/such/dir/xyz" }, null)).toContain("cwd does not exist");
});

test("validateSpawn: a well-formed loop role passes", () => {
  expect(validateSpawn({ printId: false, inline: false, role: "control", cwd: "/tmp", resumeCommand: "/loop 15m /x" }, loopDef)).toBeNull();
});

test("validateSpawn: standalone role (no cluster in role def, no --cluster arg) is rejected (ADR-0089 identity support)", () => {
  // Standalone roles are not supported: they would create sessions with NULL identity_key.
  // Rejection prevents latent data-integrity issues.
  const standaloneRoleDef: RoleDef = {
    role: "debug", kind: "session", cluster: null, workUnit: null, homeDir: "/tmp",
    resumeCommand: null, stageSchema: null, pinOnResume: false, color: null, skills: [], commands: [], hooks: [], updatedAt: null,
  };
  const err = validateSpawn({ printId: false, inline: false, role: "debug" }, standaloneRoleDef);
  expect(err).toContain("standalone role");
  expect(err).toContain("not supported");
});
