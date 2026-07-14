import type { CatalogueRow } from "./db.ts";

/**
 * The Claude Code statusline renderer (ADR-0027): a pure projection of a session's ccs
 * metadata into the one-line status Claude Code paints at the bottom of the window.
 *
 * This is the ccs-owned replacement for pr-watch's `statusline.py` + `.pr-watch.json` marker
 * + `cmux_label.py` refresh loop. It reads the ccs store directly (no private marker file),
 * so the statusline, the cmux tab (render-tab.ts), and the TUI all share ONE source and the
 * SAME phase vocabulary — they can never disagree.
 *
 * Staleness (ADR-0031/0035): a cosmetic read never asserts a stale value as current. If the
 * row's `updatedAt` is older than the freshness window, the phase renders as `unknown` rather
 * than a value that may no longer hold.
 */

/** OSC-8 terminal hyperlink: clickable TEXT that opens URL (empty url -> plain text). */
export function osc8(url: string, text: string): string {
  return url ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

/** How stale (ms) a row's phase may be before we render it as `unknown` instead of asserting
 * it as current. The statusline re-runs every turn, so this only bites a truly abandoned row. */
export const DEFAULT_STALENESS_MS = 6 * 60 * 60 * 1000; // 6h

/** A generic grouping's display bits — a {label, url} the CLUSTER supplied (ADR-0051). The
 * platform renders it clickable; it does NOT know the url is a GUS epic link. */
export interface GroupingDisplay {
  label: string | null;
  url: string | null;
}

export interface StatuslineCtx {
  /** This row's grouping display metadata (label + link), if any — supplied by the cluster. */
  grouping?: GroupingDisplay | null;
  /** Current time as epoch ms — injected so the renderer stays pure/testable. */
  nowMs: number;
  /** Override the staleness window (ms). */
  stalenessMs?: number;
  /** The composed state pill from board.json (ADR-0077): label + optional hex color. Caller
   * resolves it. When present, renders as colored text at the start of the line matching the
   * cmux tab pill exactly (same label, same color). Absent → no leading pill. */
  statePill?: { label: string; color?: string } | null;
}

/** True if the row's phase is too old to assert as current (ADR-0031). */
function phaseIsStale(row: CatalogueRow, nowMs: number, stalenessMs: number): boolean {
  if (!row.updatedAt) return true; // no timestamp -> can't vouch for it
  const t = Date.parse(row.updatedAt);
  if (Number.isNaN(t)) return true;
  return nowMs - t > stalenessMs;
}

/** Compose the PR/work label (`#123 Title` / `W-… Title` / `PR`). */
function workLabel(row: CatalogueRow): string {
  const clean = row.customTitle?.replace(/^(#\d+\s+)+/, "").trim() || "";
  let base: string;
  if (row.prNumber) base = `#${row.prNumber}`;
  else if (row.gusWork) base = row.gusWork;
  else base = "PR";
  return clean ? `${base} ${clean}` : base;
}

/** GUS deep link for a W-number. With the 18-char Salesforce record id (stamped on the row's
 * meta by the cluster's sensor, e.g. pr-watch's catalogue_sync), we produce a proper record URL;
 * without it, fall back to the object-search URL that resolves the W- by name. The search URL is
 * uglier for the user but still lands them on the right work-item after one click. */
export function gusWorkUrl(w: string, sfId: string | null | undefined): string {
  return sfId
    ? `https://gus.lightning.force.com/lightning/r/ADM_Work__c/${sfId}/view`
    : `https://gus.lightning.force.com/lightning/o/ADM_Work__c/list?filterName=Recent&search=${encodeURIComponent(w)}`;
}

/**
 * Render the statusline for a session row. Returns a single line (no trailing newline).
 * Order: state pill (colored) · linked PR/work · grouping label · W-number.
 *
 * The state pill is whatever the cluster's board composer emitted for this session — its label
 * and hex color. The tool renders both as-is (24-bit ANSI on the label so the terminal shows the
 * cmux tab's exact color). No cluster-specific vocabulary or emoji table in the tool.
 */
export function renderStatusline(row: CatalogueRow, ctx: StatuslineCtx): string {
  const stale = phaseIsStale(row, ctx.nowMs, ctx.stalenessMs ?? DEFAULT_STALENESS_MS);
  // A stale row's pill would assert a value we can't vouch for — drop it rather than mislead.
  const pill = stale ? null : (ctx.statePill ?? null);
  const pillBit = pill ? colorize(pill.label, pill.color) : null;

  const url = row.prNumber && row.prRepo ? `https://github.com/${row.prRepo}/pull/${row.prNumber}` : "";
  const linked = osc8(url, workLabel(row));

  // The grouping is a generic {label, url} the cluster supplied (ADR-0051) — clickable if a url.
  const gLabel = ctx.grouping?.label?.replace(/^\[[^\]]+\]\s*/, "") || null;
  const groupingBit = ctx.grouping?.url && gLabel ? osc8(ctx.grouping.url, gLabel) : gLabel;

  // W-number only when it isn't already the primary label (avoid "W-123 … · W-123"). Clickable
  // via OSC-8 when we know the sfId (`meta.gus_work_sf_id`), else the object-search fallback URL.
  const sfId = typeof row.meta?.gus_work_sf_id === "string" ? row.meta.gus_work_sf_id : null;
  const wBit = row.gusWork && row.prNumber ? osc8(gusWorkUrl(row.gusWork, sfId), row.gusWork) : null;

  const bits = [pillBit, linked, groupingBit, wBit].filter((b): b is string => !!b);
  return bits.join(" · ");
}

/** Wrap text in 24-bit ANSI foreground color (`#RRGGBB`), reset at the end. Skips coloring when
 * the hex is missing or malformed — the label still renders, just uncolored. */
function colorize(text: string, hex: string | undefined): string {
  if (!hex) return text;
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return text;
  const r = parseInt(m[1]!, 16);
  const g = parseInt(m[2]!, 16);
  const b = parseInt(m[3]!, 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/** A minimal, unobtrusive line for a session that isn't a tracked worker (no row / no work). */
export function defaultStatusline(fallback: string): string {
  return fallback;
}
