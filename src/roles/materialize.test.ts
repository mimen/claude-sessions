import { describe, expect, test } from "bun:test";
import { planReconcile, desiredLinksForRoles, type LinkState } from "./materialize.ts";
import type { RoleDef } from "../catalogue/db.ts";

function role(over: Partial<RoleDef>): RoleDef {
  return {
    role: "r", cluster: null, kind: "session", workUnit: null, homeDir: "/roles/r",
    resumeCommand: null, stageSchema: null, activityValues: null, skills: [], commands: [], hooks: [], updatedAt: null, ...over,
  };
}

describe("desiredLinksForRoles", () => {
  test("ADR-0074: returns empty (skills/commands no longer materialized)", () => {
    const links = desiredLinksForRoles(
      [role({ role: "control", homeDir: "/roles/control", skills: ["pr-watch-control"], commands: ["pr-watch-control"] })],
      "/home/.claude",
    );
    expect(links).toEqual([]); // ADR-0074: project-level discovery, not user-level symlinks
  });

  test("ADR-0074: a role with no home dir also returns empty", () => {
    expect(desiredLinksForRoles([role({ homeDir: null, skills: ["x"] })], "/home/.claude")).toEqual([]);
  });
});

describe("planReconcile", () => {
  const desired = [
    { linkPath: "/c/skills/a", target: "/r/skills/a" },
    { linkPath: "/c/skills/b", target: "/r/skills/b" },
  ];

  test("creates desired links that are missing", () => {
    const plan = planReconcile(desired, /*manifest*/ [], (p) => ({ kind: "absent" } as LinkState));
    expect(plan.create.map((l) => l.linkPath).sort()).toEqual(["/c/skills/a", "/c/skills/b"]);
    expect(plan.prune).toEqual([]);
    expect(plan.collisions).toEqual([]);
  });

  test("skips a desired link that already points at the right target (idempotent)", () => {
    const onDisk = (p: string): LinkState =>
      p === "/c/skills/a" ? { kind: "symlink", target: "/r/skills/a" } : { kind: "absent" };
    const plan = planReconcile(desired, ["/c/skills/a"], onDisk);
    expect(plan.create.map((l) => l.linkPath)).toEqual(["/c/skills/b"]);
  });

  test("prunes a manifest link that is no longer desired", () => {
    const onDisk = (p: string): LinkState =>
      p === "/c/skills/old" ? { kind: "symlink", target: "/r/skills/old" } : { kind: "absent" };
    const plan = planReconcile(desired, ["/c/skills/a", "/c/skills/b", "/c/skills/old"], onDisk);
    expect(plan.prune).toEqual(["/c/skills/old"]);
  });

  test("NEVER prunes a link not in the manifest (user's own file is invisible)", () => {
    // /c/skills/mine exists on disk but is not in the manifest -> not touched
    const onDisk = (): LinkState => ({ kind: "symlink", target: "/whatever" });
    const plan = planReconcile(desired, ["/c/skills/a", "/c/skills/b"], onDisk);
    expect(plan.prune).toEqual([]);
  });

  test("refuses (collision) a desired link whose path is a non-ccs real file", () => {
    const onDisk = (p: string): LinkState =>
      p === "/c/skills/a" ? { kind: "file" } : { kind: "absent" };
    const plan = planReconcile(desired, [], onDisk);
    expect(plan.collisions).toEqual(["/c/skills/a"]);
    expect(plan.create.map((l) => l.linkPath)).toEqual(["/c/skills/b"]); // b still created
  });

  test("re-points a manifest symlink whose target drifted", () => {
    const onDisk = (p: string): LinkState =>
      p === "/c/skills/a" ? { kind: "symlink", target: "/OLD/wrong" } : { kind: "absent" };
    const plan = planReconcile(desired, ["/c/skills/a"], onDisk);
    // a is ours (in manifest) but points wrong -> recreate it
    expect(plan.create.map((l) => l.linkPath).sort()).toEqual(["/c/skills/a", "/c/skills/b"]);
  });

  test("the next manifest = exactly the desired link paths", () => {
    const plan = planReconcile(desired, ["/c/skills/old"], () => ({ kind: "absent" }));
    expect(plan.nextManifest.sort()).toEqual(["/c/skills/a", "/c/skills/b"]);
  });
});
