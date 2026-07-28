import type { ClusterManifest } from "../cluster/manifest.ts";
import type { RoleDef } from "../catalogue/db.ts";

/** Claude Code's closed `--permission-mode` vocabulary (verified against `claude --help`). */
export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "manual",
  "dontAsk",
  "plan",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

const PERMISSION_MODE_SET: ReadonlySet<string> = new Set(PERMISSION_MODES);

/** True only for a permission mode Claude Code accepts on argv. */
export function isPermissionMode(value: string | null | undefined): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODE_SET.has(value);
}

/** Shared validation detail for CLI, role.toml, and cluster.toml boundaries. */
export function permissionModeValidationError(): string {
  return `permission_mode must be one of: ${PERMISSION_MODES.join(", ")}`;
}

/**
 * Role policy overrides cluster policy; birth-only legacy defaults are applied by the caller.
 *
 * A role whose manifest didn't parse resolves to NO policy — it does not fall through to the
 * cluster. That role may have been trying to declare a *narrower* posture (`plan` under a
 * `bypassPermissions` cluster) and we simply can't read it; inheriting the cluster's would grant
 * more autonomy than its author asked for. Fail-open must mean "no enforced mode", never "a more
 * permissive one". Birth refuses such a role outright (validateSpawn on manifestError); this is
 * what resume — which must stay fail-open to keep transcripts reachable — does instead.
 */
export function resolvePermissionMode(
  roleDef: Pick<RoleDef, "permissionMode" | "manifestError"> | null,
  clusterManifest: Pick<ClusterManifest, "permissionMode"> | null,
): string | null {
  if (roleDef?.manifestError) return null;
  return roleDef?.permissionMode ?? clusterManifest?.permissionMode ?? null;
}
