import { expect, test } from "bun:test";
import { isPermissionMode, resolvePermissionMode, PERMISSION_MODES } from "./permission-mode.ts";

/** Only the two fields the resolver reads — the rest of RoleDef is irrelevant here. */
const role = (permissionMode: string | null) => ({ permissionMode });
const cluster = (permissionMode: string | null) => ({ permissionMode });

test("role policy outranks cluster policy", () => {
  expect(resolvePermissionMode(role("plan"), cluster("bypassPermissions"))).toBe("plan");
});

test("cluster policy applies when the role declares none", () => {
  expect(resolvePermissionMode(role(null), cluster("bypassPermissions"))).toBe("bypassPermissions");
});

test("cluster policy applies when the role isn't resolvable at all", () => {
  expect(resolvePermissionMode(null, cluster("bypassPermissions"))).toBe("bypassPermissions");
});

test("no declared policy anywhere → null (Claude decides from settings/restored state)", () => {
  expect(resolvePermissionMode(role(null), cluster(null))).toBeNull();
  expect(resolvePermissionMode(null, null)).toBeNull();
});

test("vocabulary is closed — anything Claude Code wouldn't accept on argv is rejected", () => {
  for (const mode of PERMISSION_MODES) expect(isPermissionMode(mode)).toBe(true);
  expect(isPermissionMode("bypass")).toBe(false);          // near-miss spelling
  expect(isPermissionMode("acceptedits")).toBe(false);      // wrong case
  expect(isPermissionMode("")).toBe(false);
  expect(isPermissionMode(null)).toBe(false);
  expect(isPermissionMode(undefined)).toBe(false);
});
