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

/** Phase -> a status dot. The vocabulary is shared with the tab/board (pr-watch phases plus
 * the generic ones); an unknown phase renders no dot rather than a wrong one. */
const PHASE_DOT: Record<string, string> = {
  merged: "🟢",
  blocked: "🔴",
  milad: "🟠",
  ready: "🔵",
  review: "🟣",
  building: "⚪",
  validating: "⚪",
  reviewing: "🟣",
  unknown: "⚫",
};

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

/**
 * Render the statusline for a session row. Returns a single line (no trailing newline).
 * Order: phase dot · linked PR/work · grouping label · W-number.
 */
export function renderStatusline(row: CatalogueRow, ctx: StatuslineCtx): string {
  const stale = phaseIsStale(row, ctx.nowMs, ctx.stalenessMs ?? DEFAULT_STALENESS_MS);
  const phase = stale ? "unknown" : (row.phase ?? "").toLowerCase();
  const dot = PHASE_DOT[phase] ?? "";

  const url = row.prNumber && row.prRepo ? `https://github.com/${row.prRepo}/pull/${row.prNumber}` : "";
  const linked = osc8(url, workLabel(row));

  // The grouping is a generic {label, url} the cluster supplied (ADR-0051) — clickable if a url.
  const gLabel = ctx.grouping?.label?.replace(/^\[[^\]]+\]\s*/, "") || null;
  const groupingBit = ctx.grouping?.url && gLabel ? osc8(ctx.grouping.url, gLabel) : gLabel;

  // W-number only when it isn't already the primary label (avoid "W-123 … · W-123").
  const wBit = row.gusWork && row.prNumber ? row.gusWork : null;

  const bits = [dot, linked, groupingBit, wBit].filter((b): b is string => !!b);
  return bits.join(" · ");
}

/** A minimal, unobtrusive line for a session that isn't a tracked worker (no row / no work). */
export function defaultStatusline(fallback: string): string {
  return fallback;
}
