import type { CatalogueRow } from "../catalogue/db.ts";
import {
  ALERT_PILL_KEY,
  applyPaintOverride,
  EPIC_PILL_KEY,
  renderTab,
  type CmuxPaintOverride,
  type GroupingDisplay,
  type StatusPill,
} from "../catalogue/render-tab.ts";
import { getGrouping } from "../state/groupings.ts";
import { resolveConfig } from "../hooks/resolve-config.ts";
import { liveResolveCtx } from "../hooks/compose-claude-md.ts";
import { resolveRole } from "../roles/role-files.ts";
import type { AsyncProcessAdapter } from "../process/async.ts";

const PAINT_TIMEOUT_MS = 4_000;

function pillArgs(workspaceRef: string, pill: StatusPill | null, key: string): readonly string[] {
  if (!pill) return ["clear-status", key, "--workspace", workspaceRef];
  const args = ["set-status", pill.key, pill.label, "--workspace", workspaceRef];
  if (pill.icon) args.push("--icon", pill.icon);
  if (pill.color) args.push("--color", pill.color);
  if (pill.priority !== undefined) args.push("--priority", String(pill.priority));
  return args;
}

/** Paint a just-created workspace from the row already loaded by the resume action. */
export async function paintResumedWorkspace(
  row: CatalogueRow,
  workspaceRef: string,
  cmuxBin: string,
  processAdapter: AsyncProcessAdapter,
): Promise<void> {
  let paint: CmuxPaintOverride | null = null;
  try {
    paint = resolveConfig(row, "cmux-paint", liveResolveCtx()).effective as CmuxPaintOverride | null;
  } catch {
    paint = null;
  }

  let grouping: GroupingDisplay | null = null;
  if (row.cluster && row.groupingId) {
    try {
      const value = getGrouping(row.cluster, row.groupingId);
      if (value) grouping = { label: value.shortName ?? value.label, url: value.url };
    } catch {
      grouping = null;
    }
  }

  let paintWithRoleColor = paint;
  if (row.role && !(paint && "color" in paint)) {
    try {
      const roleColor = resolveRole(row.role, row.cluster)?.color ?? null;
      if (roleColor) paintWithRoleColor = { ...(paint ?? {}), color: roleColor };
    } catch {
      // Config is cosmetic. SessionStart and the selector sweep retry from durable state.
    }
  }

  const ops = applyPaintOverride(renderTab(row, row.kind, { grouping }), paintWithRoleColor, row);
  const commands: readonly (readonly string[])[] = [
    ["rename-workspace", "--workspace", workspaceRef, "--", ops.title],
    ops.description
      ? ["workspace-action", "--workspace", workspaceRef, "--action", "set-description", "--description", ops.description]
      : ["workspace-action", "--workspace", workspaceRef, "--action", "clear-description"],
    ops.color
      ? ["workspace-action", "--workspace", workspaceRef, "--action", "set-color", "--color", ops.color]
      : ["workspace-action", "--workspace", workspaceRef, "--action", "clear-color"],
    pillArgs(workspaceRef, ops.statusPill, "ccs_lifecycle"),
    pillArgs(workspaceRef, ops.epicPill, EPIC_PILL_KEY),
    pillArgs(workspaceRef, ops.alertPill ?? null, ALERT_PILL_KEY),
    ...(row.kind === "session"
      ? [["clear-status", "claude_code", "--workspace", workspaceRef] as const]
      : []),
  ];

  for (const args of commands) {
    await processAdapter.run(cmuxBin, args, { timeoutMs: PAINT_TIMEOUT_MS });
  }
}
