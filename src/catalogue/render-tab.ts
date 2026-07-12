import type { CatalogueRow, Kind } from "./db.ts";
import { lifecycleOf, identityKeyOf } from "./db.ts";

/**
 * A tab's render ops: the full set of cmux workspace visual attrs we push.
 * Title/description/color/pill — a pure stateless projection of a catalogue row.
 */
export interface TabRenderOps {
  title: string;
  description: string | null;
  color: string | null;
  statusPill: StatusPill | null;
}

export interface StatusPill {
  key: string;
  label: string;
  icon?: string;
  color?: string;
  priority?: number;
}

/**
 * Pure renderer: map a catalogue row + kind to cmux workspace render ops.
 * Different templates by kind: session (worker/leaf PR work) vs loop (infra/core).
 */
/** A grouping's display bits (label + link) the cluster supplied (ADR-0051) — resolved by the
 * caller from `getGrouping(system, groupingId)`, since renderTab stays a pure projection of its args. */
export interface GroupingDisplay {
  label: string | null;
  url?: string | null;
}

/** Extra context a caller resolves and threads in (kept out of the row so renderTab stays pure). */
export interface RenderContext {
  /** This row's grouping display metadata, for the worker description line. */
  grouping?: GroupingDisplay | null;
}

export function renderTab(row: CatalogueRow, kind: Kind, ctx: RenderContext = {}): TabRenderOps {
  const base = kind === "loop" ? renderLoop(row) : renderSession(row, ctx);
  // A freeform status the session wrote about itself (ccs status) is the FRESHEST, human-authored
  // signal — it takes the description slot when present (both loops and workers). Cleared → the
  // computed description shows. This is the universal "what am I doing right now" line.
  if (row.statusLine && row.statusLine.trim()) {
    return { ...base, description: row.statusLine.trim() };
  }
  return base;
}

/**
 * A `cmux-paint` config overlay (ADR-0027/0044): the resolved most-specific-wins config for a
 * session's tab. Every field is an OPTIONAL override on the computed base ops — a role/cluster
 * customizes specific aspects (a loop's Purple color, a role-name title) without reimplementing
 * the renderer. No config → base ops unchanged (backward-compatible). A `null` explicitly clears
 * (e.g. `"color": null` forces no color); an absent key leaves the base value.
 */
export interface CmuxPaintOverride {
  title?: string;
  description?: string | null;
  color?: string | null;
  statusPill?: StatusPill | null;
}

/** Overlay a resolved cmux-paint config onto the computed base ops. Pure. */
export function applyPaintOverride(base: TabRenderOps, over: CmuxPaintOverride | null): TabRenderOps {
  if (!over) return base;
  return {
    title: over.title ?? base.title, // title never nulls (a tab must have a name)
    description: "description" in over ? over.description ?? null : base.description,
    color: "color" in over ? over.color ?? null : base.color,
    statusPill: "statusPill" in over ? over.statusPill ?? null : base.statusPill,
  };
}

function renderSession(row: CatalogueRow, ctx: RenderContext): TabRenderOps {
  const title = buildSessionTitle(row);
  const description = buildSessionDescription(row, ctx);
  // Workers carry NO sidebar color: the phase pill (below) already encodes state with its own
  // color, so a tab color would be redundant noise. State lives in the pill; the tab stays neutral.
  const color = null;
  // A worker's pill prefers its pipeline PHASE (building/reviewing/…) — the one-glance position
  // in the pr-watch pipeline — falling back to the lifecycle pill (parked/done/archived) when
  // there's no phase. This is what the retired cmux_label.py used to paint; it now lives in the
  // single ccs renderer, sourced from the row's `phase` (the engine senses it in).
  const statusPill = computePhasePill(row) ?? computeLifecyclePill(row);
  return { title, description, color, statusPill };
}

function renderLoop(row: CatalogueRow): TabRenderOps {
  // role is the canonical label (ADR-0015). A loop's tab reads best as its
  // role name (control/scout/eval), falling back to custom title / key / id.
  const title =
    row.customTitle || row.role || identityKeyOf(row) || row.sessionId.slice(0, 8);
  const description = buildLoopDescription(row);
  const color = "Purple";
  // A loop's pill is just the generic lifecycle pill (parked/done). The old role-specific
  // "sensed status" pill (control health / eval grade) rode on the free-form `phase` column,
  // which is retired (ADR-0059) — that pill wasn't intentional functionality, so it's gone.
  const statusPill = computeLifecyclePill(row);
  return { title, description, color, statusPill };
}

/** Strip any leading "#<num> " groups so the PR# is never baked into the name — the
 * renderer composes it once from prNumber. Guards against dirty stored titles that
 * already carry the prefix (which would otherwise double/triple: "#12133 #12133 …"). */
function stripPrPrefix(title: string): string {
  return title.replace(/^(#\d+\s+)+/, "");
}

function buildSessionTitle(row: CatalogueRow): string {
  const clean = row.customTitle ? stripPrPrefix(row.customTitle) : null;
  if (row.prNumber && clean) {
    return `#${row.prNumber} ${clean}`;
  }
  if (clean) {
    return clean;
  }
  const key = identityKeyOf(row);
  if (key) return key;
  if (row.role) return row.role; // a role-tagged session with no title reads as its role
  return row.sessionId.slice(0, 8);
}

function buildSessionDescription(row: CatalogueRow, ctx: RenderContext): string | null {
  const parts: string[] = [];
  // The cluster name (system) is dropped: it's the same for every pr-watch worker, so it's noise.
  // The grouping (epic) is the useful worker context — a worker belongs to an epic and that's what
  // you scan by. Prefer the cluster-supplied short label, stripped of any `[tag]` prefix; fall back
  // to the W-number so there's always a grouping anchor.
  const epicLabel = ctx.grouping?.label?.replace(/^\[[^\]]+\]\s*/, "") || null;
  if (epicLabel) parts.push(epicLabel);
  else if (row.gusWork) parts.push(row.gusWork);
  const key = identityKeyOf(row);
  if (key) parts.push(key);
  if (row.project) parts.push(row.project);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function buildLoopDescription(row: CatalogueRow): string | null {
  // A core-role tab's TITLE already leads with the cluster (`pr-watch • control`, via the
  // cmux-paint config), so repeating `system` here is noise. Only surface an identity key if the
  // loop has a distinguishing one; otherwise the loop needs no second line at all.
  const key = identityKeyOf(row);
  return key || null;
}

/** A worker's pipeline PHASE → sidebar pill (label + icon + hex color). Mirrors the mapping the
 * retired cmux_label.py owned, now sourced from the row's `phase` (the engine senses it in). The
 * pill uses the SAME key as the lifecycle pill so the two never stack — a worker shows one status
 * pill, whichever applies. Returns null for an unknown/empty phase (caller falls back to lifecycle). */
// The pr-agent phase = STAGE × ACTIVITY (see roles/pr-agent/docs/phase-state-machine.md).
// STAGE (monotonic, forward-only) gives the base label + color; ACTIVITY overlays it (needs-you /
// fixing recolor + relabel; working shows the stage as-is).
const STAGE_PILL: Record<string, { label: string; icon: string; color: string }> = {
  building:       { label: "building",    icon: "hammer",             color: "#32ade6" }, // cyan
  "milad-review": { label: "your review", icon: "eye",                color: "#0a84ff" }, // blue — awaiting your +1
  "in-review":    { label: "in review",   icon: "person.2",           color: "#bf5af2" }, // purple — external review
  approved:       { label: "approved",    icon: "checkmark.circle",   color: "#30d158" }, // green
  merged:         { label: "merged",      icon: "checkmark.seal",     color: "#34c759" }, // green
};
// ACTIVITY overlay: needs-you and fixing take over the pill (they're the urgent within-stage
// states); working defers to the stage's own pill. Legacy single-`phase` values map here too.
const ACTIVITY_OVERLAY: Record<string, { label: string; icon: string; color: string }> = {
  "needs-you": { label: "needs you", icon: "person.crop.circle",     color: "#ff9500" }, // amber
  fixing:      { label: "fixing",    icon: "wrench.and.screwdriver", color: "#ff6f22" }, // orange
};

/**
 * Compose the worker pill from STAGE × ACTIVITY. Stage gives the base (label + color); an urgent
 * activity (needs-you / fixing) overlays it, keeping the stage word so you still know WHERE it's
 * stuck (e.g. "in review · fixing"). `working` just shows the stage. Null when there's no stage
 * (caller → lifecycle pill). The legacy single `phase` column is gone (ADR-0059).
 */
function computePhasePill(row: CatalogueRow): StatusPill | null {
  const stageKey = row.stage?.trim().toLowerCase();
  if (!stageKey || !STAGE_PILL[stageKey]) return null;
  const stage = STAGE_PILL[stageKey];
  const act = row.activity?.trim().toLowerCase();
  const overlay = act && ACTIVITY_OVERLAY[act];
  if (overlay) {
    // Keep the stage word so the pill says both: "your review · fixing", "in review · needs you".
    return { key: "ccs_lifecycle", label: `${stage.label} · ${overlay.label}`, icon: overlay.icon, color: overlay.color, priority: 50 };
  }
  return { key: "ccs_lifecycle", label: stage.label, icon: stage.icon, color: stage.color, priority: 50 };
}

function computeLifecyclePill(row: CatalogueRow): StatusPill | null {
  const lc = lifecycleOf(row);
  if (lc === "idle") return null;
  const labels: Record<string, string> = {
    parked: "parked",
    completed: "done",
    archived: "archived",
  };
  const label = labels[lc];
  if (!label) return null;
  return {
    key: "ccs_lifecycle",
    label,
    priority: 50,
  };
}
