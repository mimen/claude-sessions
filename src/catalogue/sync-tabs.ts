import { existsSync } from "node:fs";
import { ensureDataDir, CATALOGUE_PATH, DB_PATH } from "../paths.ts";
import { openCatalogue, getRow, getAll, lifecycleOf, type CatalogueRow } from "./db.ts";
import { openIndex } from "../index/schema.ts";
import { resolveSelector, type SelectorKind } from "../resume/selector.ts";
import { workspaceForSession } from "../cmux/liveness.ts";
import { renderTab, applyPaintOverride, EPIC_PILL_KEY, ALERT_PILL_KEY, type CmuxPaintOverride, type StatusPill } from "./render-tab.ts";
import { resolveConfig } from "../hooks/resolve-config.ts";
import { liveResolveCtx } from "../hooks/compose-claude-md.ts";
import { getGrouping } from "../state/groupings.ts";
import { execFileSync } from "node:child_process";
import { recomposeForSession } from "../board/recompose.ts";

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
 *
 * `refOverride`: when the caller JUST created the workspace (resume/new-session) it already holds
 * the workspace ref. At that instant cmux has NOT yet bound the surface→sessionId (claude hasn't
 * booted in the new pane), so a surface-UUID lookup would return null and skip the paint — the
 * eager-paint-on-resume race. Passing the known ref paints it directly, no lookup, no race.
 */
export function pushRenderOps(
  sessionId: string,
  cmuxBin = process.env.CMUX_BIN ?? "cmux",
  refOverride?: string,
): boolean {
  // Resolve the live workspace by SURFACE UUID (the exact join key cmux exposes, ADR-0040).
  // This replaces the old cwd+title join, which clobbered the wrong tab when multiple sessions
  // shared a cwd or title. The surface UUID is unique per session and never guesses; if the
  // session isn't live, we skip (no rename). A caller-supplied ref (just-spawned workspace)
  // short-circuits the lookup to dodge the surface-binding race.
  let ref: string;
  if (refOverride) {
    ref = refOverride;
  } else {
    const loc = workspaceForSession(sessionId);
    if (!loc) return false;
    ref = loc.workspaceRef;
  }

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

  // Resolve the grouping (epic) display so the worker description can show it (ADR-0051 —
  // display metadata is cluster runtime state, not on the row). Best-effort: no grouping → null.
  let grouping = null;
  if (row.cluster && row.groupingId) {
    try {
      const g = getGrouping(row.cluster, row.groupingId);
      if (g) grouping = { label: g.shortName ?? g.label, url: g.url };
    } catch {
      grouping = null;
    }
  }

  // Role-declared color is the ONE source of truth (role.toml `color = "#RRGGBB"`) so ccs's TUI
  // role column and the cmux tab render identical bytes. cmux-paint.json's `color` still overrides
  // when set (a per-cluster/per-worker paint override), but a role no longer has to double-declare.
  // Lazy require: role-files reads the config tree, and we don't want a startup cost just to paint.
  let paintWithRoleColor = paint;
  if (row.role && !(paint && "color" in paint)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolveRole } = require("../roles/role-files.ts") as typeof import("../roles/role-files.ts");
      const roleColor = resolveRole(row.role, row.cluster)?.color ?? null;
      if (roleColor) paintWithRoleColor = { ...(paint ?? {}), color: roleColor };
    } catch {
      /* config unreadable → whatever paint already set (or nothing) */
    }
  }
  const ops = applyPaintOverride(renderTab(row, row.kind, { grouping }), paintWithRoleColor);
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

  pushPill(cmuxBin, ref, ops.statusPill, "ccs_lifecycle");
  // The epic pill (key `ccs_epic`) is a SEPARATE cmux status entry, so it coexists with the state
  // pill instead of clobbering it. Cleared explicitly when the worker has no epic, so a stale label
  // never lingers after a worker leaves its grouping.
  pushPill(cmuxBin, ref, ops.epicPill, EPIC_PILL_KEY);
  // The alert pill (key `ccs_alert`) is a third cmux status entry, emitted by the cluster's
  // composer only when there's a hard alert worth surfacing. Cleared explicitly when the composer
  // stops emitting it, so a stale ci-red label doesn't linger after CI goes green.
  pushPill(cmuxBin, ref, ops.alertPill ?? null, ALERT_PILL_KEY);

  // Suppress cmux's own `claude_code` agent-lifecycle pill on a worker's turn-end paint. The cmux
  // Claude wrapper sets it (Running / Needs input / Idle) on every hook boundary; on a sessions
  // sidebar with tight pill budget (~3 before "Show more" kicks in), the ccs epic + state pills
  // already convey what we need, and cmux's overlaps + overflows them. Clearing here makes the pill
  // GO AWAY at end-of-turn (idle state, when you're scanning tabs); it FLICKERS BACK on the next
  // interaction (SessionStart / prompt-submit / PreToolUse are separate cmux-owned hook chains we
  // can't reorder). This is best-effort + a no-op if the pill isn't set. Workers only (not loops).
  if (row.kind === "session") {
    try {
      execFileSync(cmuxBin, ["clear-status", "claude_code", "--workspace", ref], { timeout: 4000, stdio: "ignore" });
    } catch {
      // best-effort; a wedged cmux never throws up the stack
    }
  }

  return true;
}

/** Push (or clear) one keyed cmux sidebar pill. A null pill clears the key so a stale entry never
 * lingers; the key is passed explicitly so a cleared pill still knows which entry to remove.
 * Best-effort — a wedged cmux never throws up the stack. */
function pushPill(cmuxBin: string, ref: string, pill: StatusPill | null, key: string): void {
  try {
    if (pill) {
      const args = ["set-status", pill.key, pill.label, "--workspace", ref];
      if (pill.icon) args.push("--icon", pill.icon);
      if (pill.color) args.push("--color", pill.color);
      if (pill.priority !== undefined) args.push("--priority", String(pill.priority));
      execFileSync(cmuxBin, args, { timeout: 4000, stdio: "ignore" });
    } else {
      execFileSync(cmuxBin, ["clear-status", key, "--workspace", ref], { timeout: 4000, stdio: "ignore" });
    }
  } catch {
    // best-effort; cmux might be wedged
  }
}

/** Paint a SET of sessionIds — the plural is a loop over the single-paint primitive (ADR-0056).
 * Skips retired (archived/completed) rows so a defunct record never clobbers a live tab. Returns
 * counts. `rows` is the catalogue map (for the retired check); a sid absent from it still paints
 * (a just-minted session). */
function paintSet(
  sessionIds: Iterable<string>,
  rows: Map<string, CatalogueRow>,
  cmuxBin: string,
): { synced: number; notOpen: number; skippedRetired: number } {
  let synced = 0, notOpen = 0, skippedRetired = 0;
  for (const sid of sessionIds) {
    const row = rows.get(sid);
    if (row) {
      const lc = lifecycleOf(row);
      if (lc === "archived" || lc === "completed") { skippedRetired++; continue; }
    }
    if (pushRenderOps(sid, cmuxBin)) synced++;
    else notOpen++;
  }
  return { synced, notOpen, skippedRetired };
}

/**
 * `ccs sync-tabs <selector>` — paint cmux tabs from catalogue metadata (ADR-0056). Selector-driven,
 * mirroring `ccs resume <selector>` and sharing its resolution (S18): `.`/self → current session,
 * a bare UUID → that session, `--all` → every non-retired session, else a token (#pr / W-num /
 * role / cluster / epic) resolved via resolveSelector. The plural is a loop over the single-paint
 * primitive; paint is a pure function of the row (the Stop hook fires the same primitive per turn).
 */
export function syncTabs(args: string[]): number {
  const cmuxBin = process.env.CMUX_BIN ?? "cmux";
  const all = args.includes("--all");
  const token = args.find((a) => !a.startsWith("--"));

  // `.`/self/no-arg → the current session (the single-paint primitive, no DB needed).
  if (!all && (!token || token === "." || token === "self")) {
    const sessionId = resolveSessionId(token);
    if (!sessionId) return notInSession();
    // Freshness (ADR-0077): recompose this identity's row before painting so the tab reflects
    // any pending state changes (e.g. a meta write in this same script) instead of last tick's.
    recomposeForSession(sessionId);
    const pushed = pushRenderOps(sessionId, cmuxBin);
    console.log(pushed ? `synced tab for ${sessionId.slice(0, 8)}…` : `${sessionId.slice(0, 8)}… not open / not synced`);
    return 0;
  }

  if (!existsSync(CATALOGUE_PATH())) {
    console.error("No catalogue found (run ccs reindex first).");
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    const rows = getAll(db);

    // --all → every session (paintSet skips retired).
    if (all) {
      const r = paintSet(rows.keys(), rows, cmuxBin);
      console.log(`synced ${r.synced} tab(s) (${r.notOpen} not open / not synced)`);
      return 0;
    }

    // A bare UUID → paint that one directly (no selector lookup needed).
    if (token && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(token)) {
      recomposeForSession(token);
      const pushed = pushRenderOps(token, cmuxBin);
      console.log(pushed ? `synced tab for ${token.slice(0, 8)}…` : `${token.slice(0, 8)}… not open / not synced`);
      return 0;
    }

    // Otherwise resolve the selector (#pr / W-num / role / cluster / epic) to a set (S18).
    const idx = openIndex(DB_PATH());
    try {
      const sel = resolveSelector(db, idx, token!, selectorPin(args));
      if (!sel || sel.sessionIds.length === 0) {
        console.error(`ccs sync-tabs: "${token}" matched no sessions`);
        return 1;
      }
      const r = paintSet(sel.sessionIds, rows, cmuxBin);
      console.log(`synced ${r.synced}/${sel.sessionIds.length} tab(s) for ${sel.label} (${r.notOpen} not open)`);
      return 0;
    } finally {
      idx.close();
    }
  } finally {
    db.close();
  }
}

/** Read the axis pin from flags (mirrors `ccs resume`), so `--role`/`--cluster`/etc. disambiguate. */
function selectorPin(args: string[]): { pin?: SelectorKind; cluster?: string } {
  const pin: SelectorKind | undefined =
    args.includes("--role") ? "role"
    : args.includes("--pr") ? "pr"
    : args.includes("--gus") ? "gus-work"
    : args.includes("--epic") ? "epic"
    : args.includes("--cluster") ? "cluster"
    : args.includes("--key") ? "key"
    : undefined;
  return { pin };
}
