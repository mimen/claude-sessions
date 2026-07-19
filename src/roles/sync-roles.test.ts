import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSyncRoles, desiredStatusline, desiredHooks } from "./sync-roles.ts";

/** Author a role package under a temp $CCS_CONFIG_ROOT, then plan the reconcile into a temp
 * ~/.claude. Roles are files now (ADR-0050), so setup writes role.toml + skills/commands dirs. */
function withConfig<T>(fn: (cfg: string, claude: string) => T): T {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-sr-cfg-"));
  const claude = mkdtempSync(join(tmpdir(), "ccs-sr-claude-"));
  const prev = process.env.CCS_CONFIG_ROOT;
  process.env.CCS_CONFIG_ROOT = cfg;
  try { return fn(cfg, claude); }
  finally {
    prev === undefined ? delete process.env.CCS_CONFIG_ROOT : (process.env.CCS_CONFIG_ROOT = prev);
    rmSync(cfg, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
}

function writeRole(cfg: string, cluster: string, role: string, opts: { skills?: string[]; commands?: string[] } = {}) {
  const d = join(cfg, "clusters", cluster, "roles", role);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "role.toml"), 'kind = "loop"\n');
  for (const s of opts.skills ?? []) mkdirSync(join(d, "skills", s), { recursive: true });
  for (const c of opts.commands ?? []) { mkdirSync(join(d, "commands"), { recursive: true }); writeFileSync(join(d, "commands", `${c}.md`), "x"); }
}

test("ADR-0074: planSyncRoles creates no links (skills/commands no longer materialized)", () => {
  withConfig((cfg, claude) => {
    writeRole(cfg, "pr-watch", "control", { skills: ["pr-watch-control"], commands: ["pr-watch-control"] });
    const plan = planSyncRoles(claude);
    expect(plan.create).toEqual([]); // ADR-0074: project-level discovery, not user-level symlinks
    expect(plan.collisions).toEqual([]); // nothing desired → no collisions
  });
});

test("ADR-0074: user files in ~/.claude/skills are untouched (no collisions)", () => {
  withConfig((cfg, claude) => {
    writeRole(cfg, "c", "r", { skills: ["mine"] });
    mkdirSync(join(claude, "skills"), { recursive: true });
    writeFileSync(join(claude, "skills/mine"), "hand-made"); // user's own file
    const plan = planSyncRoles(claude);
    expect(plan.collisions).toEqual([]); // ADR-0074: no desired links → nothing to collide
    expect(plan.create).toEqual([]);
  });
});

test("desiredStatusline: unconditional (ccs statusline self-filters, ADR-0048 model A)", () => {
  expect(desiredStatusline().command).toBe("ccs statusline");
});

test("desiredHooks: the two GLOBAL hooks, wired unconditionally", () => {
  const events = desiredHooks().map((h) => h.event).sort();
  expect(events).toEqual(["SessionStart", "Stop"]);
});
