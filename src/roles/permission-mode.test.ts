import { expect, test } from "bun:test";
import { isPermissionMode, resolvePermissionMode, PERMISSION_MODES } from "./permission-mode.ts";

/** Only the fields the resolver reads — the rest of RoleDef is irrelevant here. */
const role = (permissionMode: string | null, manifestError: string | null = null) =>
  ({ permissionMode, manifestError });
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

test("a role whose manifest didn't parse resolves to NO policy, not the cluster's", () => {
  // The role may have been declaring a NARROWER posture we can't read; inheriting the cluster's
  // would grant more autonomy than its author asked for. Fail-open ≠ fail-permissive.
  expect(resolvePermissionMode(role(null, "malformed role.toml"), cluster("bypassPermissions"))).toBeNull();
  // …and that holds even if the role's own value parsed fine but something else in the file didn't.
  expect(resolvePermissionMode(role("plan", "model must be one of: …"), cluster("bypassPermissions"))).toBeNull();
});

test("vocabulary is closed — anything Claude Code wouldn't accept on argv is rejected", () => {
  for (const mode of PERMISSION_MODES) expect(isPermissionMode(mode)).toBe(true);
  expect(isPermissionMode("bypass")).toBe(false);          // near-miss spelling
  expect(isPermissionMode("acceptedits")).toBe(false);      // wrong case
  expect(isPermissionMode("")).toBe(false);
  expect(isPermissionMode(null)).toBe(false);
  expect(isPermissionMode(undefined)).toBe(false);
});
