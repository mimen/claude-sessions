import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRole, allRolesFromFiles, rolesForClusterFromFiles, readRoleDir } from "./role-files.ts";

/** Build a temp cluster package: clusters/<c>/roles/<r>/ with role.toml + skills/commands/hooks. */
function pkg(fn: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "ccs-rolefiles-"));
  fn(root);
  return root;
}
const roleDir = (root: string, cluster: string, role: string) =>
  join(root, "clusters", cluster, "roles", role);

function writeRole(root: string, cluster: string, role: string, toml: string, opts: { skills?: string[]; commands?: string[]; hooks?: string[] } = {}) {
  const d = roleDir(root, cluster, role);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "role.toml"), toml);
  for (const s of opts.skills ?? []) mkdirSync(join(d, "skills", s), { recursive: true });
  for (const c of opts.commands ?? []) { mkdirSync(join(d, "commands"), { recursive: true }); writeFileSync(join(d, "commands", `${c}.md`), "x"); }
  for (const h of opts.hooks ?? []) { mkdirSync(join(d, ".ccs-hooks"), { recursive: true }); writeFileSync(join(d, ".ccs-hooks", `${h}.json`), "{}"); }
}

test("readRoleDir: role.toml carries only kind + resume_command; rest is derived", () => {
  const root = pkg((r) => writeRole(r, "pr-watch", "control", 'kind = "loop"\nresume_command = "/loop 15m /x"',
    { skills: ["pr-watch-control"], commands: ["pr-watch-control"], hooks: ["session-start", "start"] }));
  try {
    const def = readRoleDir(roleDir(root, "pr-watch", "control"), "control", "pr-watch")!;
    expect(def.role).toBe("control");         // = dir name
    expect(def.cluster).toBe("pr-watch");      // = parent path
    expect(def.kind).toBe("loop");             // from toml
    expect(def.resumeCommand).toBe("/loop 15m /x");
    expect(def.homeDir).toBe(roleDir(root, "pr-watch", "control")); // computed, not stored
    expect(def.skills).toEqual(["pr-watch-control"]);      // file-presence
    expect(def.commands).toEqual(["pr-watch-control"]);    // *.md base-name
    expect(def.hooks.sort()).toEqual(["session-start", "start"]); // .ccs-hooks presence
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveRole: finds a cluster role by name", () => {
  const root = pkg((r) => writeRole(r, "pr-watch", "pr-agent", 'kind = "session"'));
  try {
    const def = resolveRole("pr-agent", root)!;
    expect(def.cluster).toBe("pr-watch");
    expect(def.kind).toBe("session");
    expect(def.resumeCommand).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveRole: a standalone role (no cluster) resolves with cluster=null", () => {
  const root = pkg((r) => { const d = join(r, "roles", "solo"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "role.toml"), 'kind = "session"'); });
  try {
    const def = resolveRole("solo", root)!;
    expect(def.cluster).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveRole: same role name in TWO clusters — cluster-scoped call disambiguates (no collision)", () => {
  // Punch-list guarantee: `pr-agent` defined in both cluster-A and cluster-B
  // must resolve to the correct one when the caller passes cluster. This is
  // ADR-D3's whole point — role identity is (cluster, role), not global.
  const root = pkg((r) => {
    writeRole(r, "cluster-a", "pr-agent", 'kind = "session"\nresume_command = "/from-a"');
    writeRole(r, "cluster-b", "pr-agent", 'kind = "loop"\nresume_command = "/from-b"');
  });
  try {
    const a = resolveRole("pr-agent", "cluster-a", root)!;
    expect(a.cluster).toBe("cluster-a");
    expect(a.kind).toBe("session");
    expect(a.resumeCommand).toBe("/from-a");
    const b = resolveRole("pr-agent", "cluster-b", root)!;
    expect(b.cluster).toBe("cluster-b");
    expect(b.kind).toBe("loop");
    expect(b.resumeCommand).toBe("/from-b");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveRole: legacy no-cluster call on a collision → warns to stderr, returns alphabetically-first", () => {
  // The legacy overload (no cluster passed) is warn-then-pick-first. Callers
  // that hit the warning should be updated to pass cluster; the warning
  // exists so partial migrations don't silently pick 'wrong' cluster.
  const root = pkg((r) => {
    writeRole(r, "cluster-b", "pr-agent", 'kind = "loop"');   // b < c alphabetically
    writeRole(r, "cluster-c", "pr-agent", 'kind = "session"');
  });
  const origErr = console.error;
  let stderr = "";
  console.error = (...a: unknown[]) => { stderr += a.map((x) => String(x)).join(" ") + "\n"; };
  try {
    const def = resolveRole("pr-agent", root)!; // legacy: root passed via 2-arg overload
    expect(def).not.toBeNull();
    expect(def.cluster).toBe("cluster-b"); // first hit by dirNames() order
    expect(stderr).toContain("ambiguous");
    expect(stderr).toContain("pr-agent");
    expect(stderr).toContain("cluster-b");
    expect(stderr).toContain("cluster-c");
  } finally {
    console.error = origErr;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRole: unknown role → null", () => {
  const root = pkg(() => {});
  try {
    expect(resolveRole("ghost", root)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("readRoleDir: missing role.toml → empty manifest (kind null), still derives presence", () => {
  const root = pkg((r) => { const d = roleDir(r, "c", "bare"); mkdirSync(join(d, "skills", "s"), { recursive: true }); });
  try {
    const def = readRoleDir(roleDir(root, "c", "bare"), "bare", "c")!;
    expect(def.kind).toBeNull();
    expect(def.skills).toEqual(["s"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("allRolesFromFiles: gathers every cluster + standalone role", () => {
  const root = pkg((r) => {
    writeRole(r, "pr-watch", "control", 'kind = "loop"');
    writeRole(r, "pr-watch", "pr-agent", 'kind = "session"');
    writeRole(r, "event-watch", "watcher", 'kind = "loop"');
  });
  try {
    const all = allRolesFromFiles(root);
    expect([...all.keys()].sort()).toEqual(["control", "pr-agent", "watcher"]);
    expect(all.get("watcher")!.cluster).toBe("event-watch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rolesForClusterFromFiles: only that cluster's roles", () => {
  const root = pkg((r) => {
    writeRole(r, "pr-watch", "control", 'kind = "loop"');
    writeRole(r, "event-watch", "watcher", 'kind = "loop"');
  });
  try {
    expect(rolesForClusterFromFiles("pr-watch", root).map((d) => d.role)).toEqual(["control"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed role.toml → fail-open (empty manifest), doesn't throw", () => {
  const root = pkg((r) => writeRole(r, "c", "broken", "this is { not toml"));
  try {
    const def = resolveRole("broken", root)!;
    expect(def.kind).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ADR-0074: skills/commands read from .claude/ (project-local), with legacy fallback", () => {
  const root = pkg((r) => {
    const d = roleDir(r, "c", "modern");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "role.toml"), 'kind = "session"');
    // Modern: .claude/skills + .claude/commands
    mkdirSync(join(d, ".claude", "skills", "modern-skill"), { recursive: true });
    mkdirSync(join(d, ".claude", "commands"), { recursive: true });
    writeFileSync(join(d, ".claude", "commands", "modern-cmd.md"), "x");
    // Legacy (should be ignored when .claude/ exists)
    mkdirSync(join(d, "skills", "legacy-skill"), { recursive: true });
    mkdirSync(join(d, "commands"), { recursive: true });
    writeFileSync(join(d, "commands", "legacy-cmd.md"), "x");
  });
  try {
    const def = readRoleDir(roleDir(root, "c", "modern"), "modern", "c")!;
    expect(def.skills).toEqual(["modern-skill"]); // .claude/ wins, legacy ignored
    expect(def.commands).toEqual(["modern-cmd"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ADR-0074: falls back to legacy skills/commands when .claude/ is absent", () => {
  const root = pkg((r) => writeRole(r, "c", "legacy", 'kind = "session"',
    { skills: ["legacy-skill"], commands: ["legacy-cmd"] }));
  try {
    const def = readRoleDir(roleDir(root, "c", "legacy"), "legacy", "c")!;
    expect(def.skills).toEqual(["legacy-skill"]); // fallback
    expect(def.commands).toEqual(["legacy-cmd"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
