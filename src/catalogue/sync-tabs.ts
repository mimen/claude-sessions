import { existsSync } from "node:fs";
import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";
import { openCatalogue, getRow, getAll, lifecycleOf } from "./db.ts";
import { workspaceForSession } from "../cmux/liveness.ts";
import { renderTab, applyPaintOverride, type CmuxPaintOverride } from "./render-tab.ts";
import { resolveConfig } from "../hooks/resolve-config.ts";
import { liveResolveCtx } from "../hooks/compose-claude-md.ts";
import { execFileSync } from "node:child_process";

/**
 * Sync a catalogue row's metadata to its live cmux workspace tab (title/description/color/pill).
 * The cmux push is a thin untested shell; the rendering logic lives in render-tab.ts (pure + tested).
 */

/** Resolve the target session id: explicit arg, or "." → current session. */
function resolveSessionId(arg: string | undefined): string | null {
  if (!arg || arg === "." || arg === "self") return process.env.CLAUDE_CODE_SESSION_ID ?? null;
  return arg;
}

function notInSession(): number {
  console.error("Not inside a Claude Code session (CLAUDE_CODE_SESSION_ID unset).");
  return 1;
}

/**
 * Push render ops to cmux for a live/open session. Returns true if pushed, false if not open.
 * All ops are best-effort; a failed push doesn't throw (cmux might be unreachable).
 */
export function pushRenderOps(sessionId: string, cmuxBin = process.env.CMUX_BIN ?? "cmux"): boolean {
  // Resolve the live workspace by SURFACE UUID (the exact join key cmux exposes, ADR-0040).
  // This replaces the old cwd+title join, which clobbered the WRONG tab when sessions shared
  // a cwd or title (the Loop Designer rename bug, 2026-07-08). The surface UUID is unique per
  // session and never guesses; if the session isn't live, we skip (no rename).
  const loc = workspaceForSession(sessionId);
  if (!loc) return false;
  const ref = loc.workspaceRef;

  if (!existsSync(CATALOGUE_PATH())) return false;
  const db = openCatalogue(CATALOGUE_PATH());
  const row = getRow(db, sessionId);
  // Resolve the cmux-paint config overlay (ADR-0027/0044) while the db is open. Best-effort:
  // no config (or any error) → base ops unchanged. most-specific-wins so a role's paint fully
  // overrides the cluster's generic one.
  let paint: CmuxPaintOverride | null = null;
  if (row) {
    try {
      paint = resolveConfig(row, "cmux-paint", liveResolveCtx()).effective as CmuxPaintOverride | null;
    } catch {
      paint = null;
    }
  }
  db.close();
  if (!row) return false;

  const ops = applyPaintOverride(renderTab(row, row.kind), paint);
  try {
    execFileSync(cmuxBin, ["rename-workspace", "--workspace", ref, "--", ops.title], {
      timeout: 4000,
      stdio: "ignore",
    });
  } catch {
    // best-effort; cmux might be wedged
  }

  if (ops.description) {
    try {
      execFileSync(
        cmuxBin,
        ["workspace-action", "--workspace", ref, "--action", "set-description", "--description", ops.description],
        { timeout: 4000, stdio: "ignore" },
      );
    } catch {
      // best-effort
    }
  } else {
    try {
      execFileSync(cmuxBin, ["workspace-action", "--workspace", ref, "--action", "clear-description"], {
        timeout: 4000,
        stdio: "ignore",
      });
    } catch {
      // best-effort
    }
  }

  if (ops.color) {
    try {
      execFileSync(cmuxBin, ["workspace-action", "--workspace", ref, "--action", "set-color", "--color", ops.color], {
        timeout: 4000,
        stdio: "ignore",
      });
    } catch {
      // best-effort
    }
  } else {
    try {
      execFileSync(cmuxBin, ["workspace-action", "--workspace", ref, "--action", "clear-color"], {
        timeout: 4000,
        stdio: "ignore",
      });
    } catch {
      // best-effort
    }
  }

  if (ops.statusPill) {
    const args = ["set-status", ops.statusPill.key, ops.statusPill.label, "--workspace", ref];
    if (ops.statusPill.icon) args.push("--icon", ops.statusPill.icon);
    if (ops.statusPill.color) args.push("--color", ops.statusPill.color);
    if (ops.statusPill.priority !== undefined) args.push("--priority", String(ops.statusPill.priority));
    try {
      execFileSync(cmuxBin, args, { timeout: 4000, stdio: "ignore" });
    } catch {
      // best-effort
    }
  }

  return true;
}

export function syncTabs(args: string[]): number {
  const cmuxBin = process.env.CMUX_BIN ?? "cmux";
  const all = args.includes("--all");
  const sessionArg = args.find((a) => !a.startsWith("--"));

  if (all) {
    if (!existsSync(CATALOGUE_PATH())) {
      console.error("No catalogue found (run ccs reindex first).");
      return 1;
    }
    ensureDataDir();
    const db = openCatalogue(CATALOGUE_PATH());
    const catMap = getAll(db);
    db.close();

    let synced = 0;
    let notOpen = 0;
    let skippedRetired = 0;
    for (const [sid, row] of catMap) {
      // Never paint a retired session's tab: an archived/completed row must not resolve to a
      // live surface and rename it (the stale-mapping clobber — a defunct control session's
      // record renaming a live designer tab). Retired = leave the live tab alone.
      const lc = lifecycleOf(row);
      if (lc === "archived" || lc === "completed") {
        skippedRetired++;
        continue;
      }
      const pushed = pushRenderOps(sid, cmuxBin);
      if (pushed) synced++;
      else notOpen++;
    }
    console.log(`synced ${synced} tab(s) (${notOpen} not open / not synced)`);
    return 0;
  }

  const sessionId = resolveSessionId(sessionArg);
  if (!sessionId) return notInSession();

  const pushed = pushRenderOps(sessionId, cmuxBin);
  if (pushed) {
    console.log(`synced tab for ${sessionId.slice(0, 8)}…`);
  } else {
    console.log(`${sessionId.slice(0, 8)}… not open / not synced`);
  }
  return 0;
}
