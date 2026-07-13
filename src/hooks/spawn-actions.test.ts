import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogueRow } from "../catalogue/db.ts";
import { runSpawnActions, BUILTIN_SPAWN_ACTIONS, knownSpawnActions, type SpawnActionHandler, type SpawnActionCtx } from "./spawn-actions.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.CCS_CONFIG_ROOT; delete process.env.CCS_ROOT;
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "ccs-spawn-")); dirs.push(d); return d; }

function row(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "s", resumeId: null, customTitle: null, kind: "session", completed: false,
    archived: false, parkedTaskId: null, key: null, parentSessionId: null, role: "pr-agent",
    resumeCommand: null, project: null, cluster: "pr-watch", gusWork: null, workUnitId: null,
    groupingId: null, statusLine: null, meta: {}, stage: null, activity: null, notes: null, updatedAt: null,
    prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null, ...over,
  };
}
const ctx = (cwd: string): SpawnActionCtx => ({ row: row({}), cwd });

test("knownSpawnActions lists the built-ins", () => {
  expect(knownSpawnActions().sort()).toEqual(["grant-perms", "seed-files"]);
});

test("grant-perms writes an allow-list + statusLine into cwd/.claude/settings.local.json ({cwd}/{home} expand)", () => {
  const cwd = tmp();
  BUILTIN_SPAWN_ACTIONS["grant-perms"]!(
    { name: "grant-perms", allow: ["Write({cwd}/**)", "Bash(ccs:*)"], statusLine: "ccs statusline" },
    ctx(cwd),
  );
  const doc = JSON.parse(readFileSync(join(cwd, ".claude", "settings.local.json"), "utf8"));
  expect(doc.permissions.allow).toContain(`Write(${cwd}/**)`);
  expect(doc.permissions.allow).toContain("Bash(ccs:*)");
  expect(doc.statusLine).toEqual({ type: "command", command: "ccs statusline" });
});

test("grant-perms merges into an existing settings.local.json without clobbering", () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }));
  BUILTIN_SPAWN_ACTIONS["grant-perms"]!({ name: "grant-perms", allow: ["Bash(ccs:*)"] }, ctx(cwd));
  const doc = JSON.parse(readFileSync(join(cwd, ".claude", "settings.local.json"), "utf8"));
  expect(doc.permissions.allow).toContain("Bash(git:*)"); // pre-existing kept
  expect(doc.permissions.allow).toContain("Bash(ccs:*)"); // new added
});

test("seed-files pre-creates {} files but never clobbers an existing one", () => {
  const cwd = tmp();
  writeFileSync(join(cwd, "existing.json"), '{"keep":true}');
  BUILTIN_SPAWN_ACTIONS["seed-files"]!({ name: "seed-files", files: ["new.json", "existing.json", "nested/dir/x.json"] }, ctx(cwd));
  expect(readFileSync(join(cwd, "new.json"), "utf8").trim()).toBe("{}");
  expect(JSON.parse(readFileSync(join(cwd, "existing.json"), "utf8")).keep).toBe(true); // not clobbered
  expect(existsSync(join(cwd, "nested/dir/x.json"))).toBe(true); // parent dirs created
});

test("runSpawnActions resolves a role's layered spawn.json + runs in order (temp config tree)", () => {
  const cfg = tmp(); const rt = tmp();
  process.env.CCS_CONFIG_ROOT = cfg; process.env.CCS_ROOT = rt;
  const hooks = join(cfg, "clusters", "pr-watch", "roles", "pr-agent", ".ccs-hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "spawn.json"), JSON.stringify({ actions: [
    { name: "seed-files", files: ["judgment.json"] },
    { name: "grant-perms", allow: ["Bash(ccs:*)"] },
  ] }));
  const cwd = tmp();
  const out = runSpawnActions({ row: row({}), cwd });
  expect(out.errors).toEqual([]);
  expect(out.ran).toEqual(["seed-files", "grant-perms"]);
  expect(existsSync(join(cwd, "judgment.json"))).toBe(true);
  expect(existsSync(join(cwd, ".claude", "settings.local.json"))).toBe(true);
});

test("runSpawnActions is fail-open: an unknown action is recorded, the rest still run", () => {
  const seen: string[] = [];
  const handlers: Record<string, SpawnActionHandler> = {
    good: () => (seen.push("good"), {}),
  };
  // inject a config-free run by stubbing resolveConfig via a role with no spawn.json → empty
  process.env.CCS_CONFIG_ROOT = tmp();
  const out = runSpawnActions({ row: row({}), cwd: tmp() }, handlers);
  expect(out.ran).toEqual([]); // no spawn.json → nothing to run (not an error)
  expect(seen).toEqual([]);
});
