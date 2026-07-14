import type { CatalogueRow, Kind } from "./db.ts";
import { lifecycleOf, identityKeyOf } from "./db.ts";
import { boardIndex } from "../board/indexer.ts";
import type { BoardRow } from "../board/types.ts";

/**
 * A tab's render ops: the full set of cmux workspace visual attrs we push.
 * Title/description/pills — a pure stateless projection of a catalogue row.
 *
 * cmux supports many sidebar pills keyed by tool (`set-status <key> …`), so a worker carries TWO
 * orthogonal pills, each answering a different question and never clobbering the others:
 *   - STATE (`statusPill`, key `ccs_lifecycle`) — phase × activity, or the lifecycle fallback
 *   - EPIC  (`epicPill`,   key `ccs_epic`)      — the worker's grouping label ("what it's for")
 * We hold to TWO ccs pills on purpose: cmux collapses the sidebar row to "Show more" past ~3 pills,
 * and its own agent-lifecycle pill counts against that budget — a third ccs pill would push a real
 * one behind the fold. The worker's live "what I'm doing" line rides the DESCRIPTION slot instead
 * (see renderTab / the statusLine overlay), which has room for it.
 */
export interface TabRenderOps {
  title: string;
  description: string | null;
  color: string | null;
  statusPill: StatusPill | null;
  /** The worker's epic (grouping) label as its own quiet, always-on pill; null when ungrouped. */
  epicPill: StatusPill | null;
  /** A cluster-emitted alert pill (composer's pills[1]+, when the composer wants one shown).
   * Rendered as a third cmux status entry (key `ccs_alert`) — cluster owns whether it's set. */
  alertPill?: StatusPill | null;
}

/** The cmux pill key for the cluster-emitted alert pill. Distinct from ccs_lifecycle + ccs_epic
 * so alert renders alongside state + epic instead of clobbering either. */
export const ALERT_PILL_KEY = "ccs_alert";

/** The cmux pill key for the worker's epic (grouping) label — distinct from `ccs_lifecycle` so the
 * epic and the state pill coexist rather than clobber each other. */
export const EPIC_PILL_KEY = "ccs_epic";
/** The epic pill is a quiet label, not a state signal: a muted gray, no icon. It leads the pill row
 * (highest priority) so you scan the sidebar by epic first — the grouping is the primary axis — then
 * read state; its dim gray keeps it from shouting over the colored state pill despite sorting first. */
const EPIC_PILL_COLOR = "#8e8e93"; // systemGray — deliberately dim so it doesn't shout, though it leads
const EPIC_PILL_PRIORITY = 60; // above the state pill (50) so the epic sorts first

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
  // Description preference (ADR-0077 step 6):
  //   1. board.description — the composer's composed summary. Composers that want the freshest
  //      worker-authored status_line simply include it in their own description output (pr-watch
  //      does; see compose_board.py::compose_description).
  //   2. row.statusLine — legacy fallback for clusters without a board composer, and for loop
  //      sessions whose composer hasn't emitted a description yet.
  const boardDesc = descriptionFromBoard(row);
  if (boardDesc) return { ...base, description: boardDesc };
  if (row.statusLine && row.statusLine.trim()) {
    return { ...base, description: row.statusLine.trim() };
  }
  return base;
}

/** The composed description string from board.json, or null when no board / no description. */
function descriptionFromBoard(row: CatalogueRow): string | null {
  if (!row.cluster) return null;
  try {
    const hit = boardIndex(row.cluster).bySession(row.sessionId);
    const desc = hit?.row.description;
    return desc && desc.trim() ? desc.trim() : null;
  } catch {
    return null;
  }
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
  epicPill?: StatusPill | null;
  alertPill?: StatusPill | null;
}

/** Overlay a resolved cmux-paint config onto the computed base ops. Pure. */
export function applyPaintOverride(base: TabRenderOps, over: CmuxPaintOverride | null): TabRenderOps {
  if (!over) return base;
  const out: TabRenderOps = {
    title: over.title ?? base.title, // title never nulls (a tab must have a name)
    description: "description" in over ? over.description ?? null : base.description,
    color: "color" in over ? over.color ?? null : base.color,
    statusPill: "statusPill" in over ? over.statusPill ?? null : base.statusPill,
    epicPill: "epicPill" in over ? over.epicPill ?? null : base.epicPill,
  };
  // alertPill is optional in the interface — only include the key when either side sets it, so
  // {} override leaves base ops shape-identical (no synthetic null key).
  if ("alertPill" in over) out.alertPill = over.alertPill ?? null;
  else if (base.alertPill !== undefined) out.alertPill = base.alertPill;
  return out;
}

function renderSession(row: CatalogueRow, ctx: RenderContext): TabRenderOps {
  const title = buildSessionTitle(row);
  // The description holds the worker's live status prose (ccs status), overlaid in renderTab when
  // present; absent that it's blank (the epic pill carries the grouping, so no W-number fallback).
  const description = null;
  // Workers carry NO sidebar color: the phase pill (below) already encodes state with its own
  // color, so a tab color would be redundant noise. State lives in the pill; the tab stays neutral.
  const color = null;
  // Preference order (ADR-0077 migration step 3): (a) the cluster's board.json composed pill —
  // the composer applies business rules the catalogue can't see (GitHub-wins, alerts); (b) the
  // catalogue.stage fallback for clusters that don't yet publish a board; (c) the lifecycle pill
  // when neither is present. Board reads are cheap (mtime-cached indexer) and safe (falls back
  // silently on missing/stale board).
  const statusPill =
    computePillFromBoard(row) ?? computePhasePill(row) ?? computeLifecyclePill(row);
  // The worker's EPIC as its own quiet pill (orthogonal to the state pill).
  const epicPill = computeEpicPill(ctx);
  // A cluster-emitted alert pill (composer's pills[1]) when present. Renders as a third status
  // entry alongside state + epic. Cluster decides when to emit — the tool paints it as-is.
  const alertPill = computeAlertPillFromBoard(row);
  const ops: TabRenderOps = { title, description, color, statusPill, epicPill };
  if (alertPill) ops.alertPill = alertPill;
  return ops;
}

/**
 * Look up this session's composed board row and return its first pill (the state pill by
 * cluster convention: pr-watch emits stage as pill index 0). Returns null when there's no
 * cluster, no board row, or no pills — caller falls back to the legacy stage-column pill.
 *
 * Reads through the board indexer (mtime-cached); no direct filesystem work per call.
 */
function computePillFromBoard(row: CatalogueRow): StatusPill | null {
  const hit = lookupBoardRow(row);
  if (!hit || hit.pills.length === 0) return null;
  const pill = hit.pills[0]!;
  return {
    key: pill.key,
    label: pill.label,
    icon: pill.icon,
    color: pill.color,
    priority: pill.priority ?? 50,
  };
}

/** Cluster-emitted alert pill: the composer's pills[1] (present iff the cluster wants an alert
 * shown). Returns null when there's no cluster, no board row, or the composer emitted only one
 * pill. Rendered as a distinct cmux status entry (ccs_alert), so it coexists with state + epic. */
function computeAlertPillFromBoard(row: CatalogueRow): StatusPill | null {
  const hit = lookupBoardRow(row);
  if (!hit || hit.pills.length < 2) return null;
  const pill = hit.pills[1]!;
  return {
    key: ALERT_PILL_KEY,
    label: pill.label,
    icon: pill.icon,
    color: pill.color,
    priority: pill.priority ?? 40,
  };
}

/** Session → composed board row. null when the session isn't in any cluster or board is empty. */
function lookupBoardRow(row: CatalogueRow): BoardRow | null {
  if (!row.cluster) return null;
  try {
    return boardIndex(row.cluster).bySession(row.sessionId)?.row ?? null;
  } catch {
    return null;
  }
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
  // Loops (core roles) belong to no epic — no epic pill; their status rides the description slot.
  return { title, description, color, statusPill, epicPill: null };
}

/** Strip any leading "#<num> " groups so the PR# is never baked into the name — the
 * renderer composes it once from prNumber. Guards against dirty stored titles that
 * already carry the prefix (which would otherwise double/triple: "#12133 #12133 …"). */
function stripPrPrefix(title: string): string {
  return title.replace(/^(#\d+\s+)+/, "");
}

function buildSessionTitle(row: CatalogueRow): string {
  // A worker authors a short display name (`meta.shortname`, ≤25ch) so the tab reads
  // "#12137 addons plan list" instead of the full, mid-word-truncated PR title. It lives in `meta`
  // (not customTitle) because catalogue_sync overwrites customTitle with the full PR title each
  // tick; the shortname is the worker's own stable label and must survive that. Fall back to the
  // cleaned customTitle when no shortname is set.
  const shortname = shortnameOf(row);
  const clean = shortname || (row.customTitle ? stripPrPrefix(row.customTitle) : null);
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

/** The worker's short display name from `meta.shortname`, trimmed + clamped to 35ch. Null when
 * unset/blank so the title falls back to the cleaned PR title. */
function shortnameOf(row: CatalogueRow): string | null {
  const raw = row.meta?.shortname;
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\s+/g, " ");
  return s ? s.slice(0, 35) : null;
}

/** The worker's epic → a quiet, always-on label pill (key `ccs_epic`). Muted gray, no icon, low
 * priority so it sorts after the colored state pill. Null when the worker has no grouping label
 * (ungrouped / not yet sensed) — the caller then clears any stale epic pill. Strips a leading
 * `[tag]` prefix the same way the description used to. */
function computeEpicPill(ctx: RenderContext): StatusPill | null {
  const label = ctx.grouping?.label?.replace(/^\[[^\]]+\]\s*/, "").trim() || null;
  if (!label) return null;
  return { key: EPIC_PILL_KEY, label, color: EPIC_PILL_COLOR, priority: EPIC_PILL_PRIORITY };
}

function buildLoopDescription(row: CatalogueRow): string | null {
  // A core-role tab's TITLE already leads with the cluster (`pr-watch • control`, via the
  // cmux-paint config), so repeating `system` here is noise. Only surface an identity key if the
  // loop has a distinguishing one; otherwise the loop needs no second line at all.
  const key = identityKeyOf(row);
  return key || null;
}

/** A worker's pipeline STAGE → sidebar pill (label + icon + hex color). Sourced from the row's
 * `stage` column (the engine senses it in). Uses the same `ccs_lifecycle` key as the lifecycle
 * pill so a worker shows one status pill at a time — whichever applies. */
const STAGE_PILL: Record<string, { label: string; icon: string; color: string }> = {
  building:       { label: "building",    icon: "hammer",             color: "#32ade6" }, // cyan
  "milad-review": { label: "your review", icon: "eye",                color: "#0a84ff" }, // blue — awaiting your +1
  "in-review":    { label: "in review",   icon: "person.2",           color: "#bf5af2" }, // purple — external review
  approved:       { label: "approved",    icon: "checkmark.circle",   color: "#30d158" }, // green
  merged:         { label: "merged",      icon: "checkmark.seal",     color: "#34c759" }, // green
};

/**
 * Compute the worker pill from the row's stage. Activity is dead (2026-07-13); no overlay logic.
 * Returns null when there's no stage (caller → lifecycle pill).
 */
function computePhasePill(row: CatalogueRow): StatusPill | null {
  const stageKey = row.stage?.trim().toLowerCase();
  if (!stageKey || !STAGE_PILL[stageKey]) return null;
  const stage = STAGE_PILL[stageKey];
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
