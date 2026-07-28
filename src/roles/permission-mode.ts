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

/** Role policy overrides cluster policy; birth-only legacy defaults are applied by the caller. */
export function resolvePermissionMode(
  roleDef: Pick<RoleDef, "permissionMode"> | null,
  clusterManifest: Pick<ClusterManifest, "permissionMode"> | null,
): string | null {
  return roleDef?.permissionMode ?? clusterManifest?.permissionMode ?? null;
}
