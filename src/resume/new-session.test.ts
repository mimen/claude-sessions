import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, getRow, lifecycleOf, identityKeyOf, setCluster, stampPrFacts, setWorkUnitId, getMeta } from "../catalogue/db.ts";
import { resolveWorkUnit } from "../catalogue/resolve-work-unit.ts";
import { parseOpts, writeSessionMetadata } from "./new-session.ts";

const NOW = "2026-07-08T00:00:00.000Z";

const roots: string[] = [];
afterEach(() => {
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
}

test("supersede-on-spawn: a new worker archives prior sessions of the same work-unit (ADR-0073)", () => {
  withPrRole();
  const db = openCatalogue(":memory:");
  try {
    // an OLD worker already on PR heroku/dashboard#12080 (linked to the work-unit)
    const oldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    setCluster(db, oldId, "pr-watch", NOW);
    stampPrFacts(db, oldId, { prNumber: 12080, prRepo: "heroku/dashboard", prBranch: "b", prState: "open", prHeadSha: "s" }, NOW);
    const wu = resolveWorkUnit("pr-watch", { prRepo: "heroku/dashboard", prNumber: 12080 }, NOW);
    setWorkUnitId(db, oldId, wu, NOW);
    expect(lifecycleOf(getRow(db, oldId)!)).toBe("idle");

    // spawn a FRESH worker for the same PR
    const newId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    writeSessionMetadata(db, newId, parseOpts([
      "--cluster", "pr-watch", "--role", "pr-agent",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);

    // the old one is now archived (expired), with a pointer to who superseded it
    expect(lifecycleOf(getRow(db, oldId)!)).toBe("archived");
    expect(getMeta(getRow(db, oldId)!, "superseded_by")).toBe(newId);
    // the new one is live/idle + linked to the SAME work-unit id (find-or-create)
    expect(lifecycleOf(getRow(db, newId)!)).toBe("idle");
    expect(getRow(db, newId)!.workUnitId).toBe(wu);
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

test("writeSessionMetadata: binds identity to a not-yet-indexed id (forward reference)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "11111111-2222-3333-4444-555555555555";
    writeSessionMetadata(db, id, parseOpts([
      "--cluster", "pr-watch",
      "--role", "pr-agent",
      "--key", "heroku_dashboard-12080",
      "--title", "#12080 Fix navbar",
    ]), NOW);

    const row = getRow(db, id);
    expect(row).not.toBeNull();
    expect(row!.cluster).toBe("pr-watch");
    expect(row!.role).toBe("pr-agent"); // canonical role axis (ADR-0015)
    // kind derives from the role (ADR-0062); pr-agent has no resume_command → "session".
    expect(row!.kind).toBe("session");
    expect(identityKeyOf(row)).toBe("heroku_dashboard-12080");
    expect(row!.customTitle).toBe("#12080 Fix navbar");
    // The id is recorded as its own resume handle, so `ccs resume` can revive it pre-index.
    expect(row!.resumeId).toBe(id);
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: a leading slash on the role is normalised away", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    writeSessionMetadata(db, id, parseOpts(["--role", "/pr-watch-control"]), NOW);
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
      "--role", "pr-agent", "--gus-work", "W-23034218",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);
    const row = getRow(db, id)!;
    expect(row.gusWork).toBe("W-23034218");
    expect(row.prNumber).toBe(12080);
    expect(row.prRepo).toBe("heroku/dashboard");
    expect(row.prState).toBe("open"); // sensible default until git-sense refines it
  } finally {
    db.close();
  }
});

test("parseOpts: --pr-number 0 (no PR yet) is treated as absent, not stamped", () => {
  const o = parseOpts(["--pr-number", "0", "--pr-repo", "heroku/dashboard"]);
  expect(o.prNumber).toBeUndefined();
});

test("writeSessionMetadata: --resume-command is stored for a loop (comes back running)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "ffffffff-0000-1111-2222-333333333333";
    // ADR-D3: role resolution is (cluster, role); pass --cluster so the derived resumeCommand
    // finds the pr-watch/control role.toml on this developer machine.
    writeSessionMetadata(
      db,
      id,
      parseOpts(["--cluster", "pr-watch", "--role", "control", "--resume-command", "/loop 15m /pr-watch-control"]),
      NOW,
    );
    expect(getRow(db, id)!.resumeCommand).toBe("/loop 15m /pr-watch-control");
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: only the provided fields are written (no clobber to defaults)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "99999999-8888-7777-6666-555555555555";
    writeSessionMetadata(db, id, parseOpts(["--cluster", "pr-watch"]), NOW);
    const row = getRow(db, id)!;
    expect(row.cluster).toBe("pr-watch");
    expect(row.customTitle).toBeNull();
    // A bare new session is idle by default (nothing set completed/archived/parked).
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
