import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSyncRoles } from "./sync-roles.ts";
import { openCatalogue, upsertRole } from "../catalogue/db.ts";

const NOW = "2026-07-09T00:00:00Z";

/** Drive the pure plan against a temp ~/.claude so we test reconcile end-to-end without homedir. */
test("planSyncRoles: desired links for a role's skills + commands", () => {
  const claude = mkdtempSync(join(tmpdir(), "ccs-claude-"));
  const db = openCatalogue(":memory:");
  try {
    upsertRole(db, {
      role: "control", cluster: "pr-watch", kind: "loop",
      homeDir: "/roles/control", skills: ["pr-watch-control"], commands: ["pr-watch-control"], now: NOW,
    });
    const plan = planSyncRoles(db, claude);
    const created = plan.create.map((l) => l.linkPath).sort();
    // Commands materialize with a `.md` extension (Claude Code slash-command files are
    // `<name>.md`); skills are directories, so no extension.
    expect(created).toEqual([
      join(claude, "commands/pr-watch-control.md"),
      join(claude, "skills/pr-watch-control"),
    ]);
    expect(plan.collisions).toEqual([]);
  } finally {
    db.close();
    rmSync(claude, { recursive: true, force: true });
  }
});

test("planSyncRoles: a real user file at a desired path is a collision, not clobbered", () => {
  const claude = mkdtempSync(join(tmpdir(), "ccs-claude-"));
  const db = openCatalogue(":memory:");
  try {
    mkdirSync(join(claude, "skills"), { recursive: true });
    writeFileSync(join(claude, "skills/mine"), "hand-made"); // user's own skill
    upsertRole(db, { role: "r", homeDir: "/roles/r", skills: ["mine"], now: NOW });
    const plan = planSyncRoles(db, claude);
    expect(plan.collisions).toEqual([join(claude, "skills/mine")]);
    expect(plan.create).toEqual([]); // refused, not created
  } finally {
    db.close();
    rmSync(claude, { recursive: true, force: true });
  }
});
