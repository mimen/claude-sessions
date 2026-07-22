import type { CatalogueRow } from "./db.ts";
import { familyOf } from "../tui/format.ts";
import { theme, costColor, fullnessColor } from "../tui/theme.ts";
import { formatCost } from "../cost.ts";

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

/**
 * Section separator for BOTH statusline rows: a faint pipe with air either side. The status bar
 * has the full terminal width to play with, so sections get real breathing room; the rule divides
 * them unambiguously where bare whitespace could read as accidental spacing. Drawn in `faint` so
 * it recedes behind the values. In-section spacing stays a single space (`medium ⚡fast`), which
 * keeps each section reading as one unit against the wider rule.
 */
const SEP = colorize("  │  ", theme.faint);

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
  /** Optional review-app URL (fleet identity attr). Rendered as clickable `↗ review-app`. */
  reviewAppUrl?: string | null;
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

  // Review-app URL — a clickable link that lets the reviewer jump straight to the deployed
  // preview without hunting through GitHub's deployments tab. Absent (no PR / not deployed
  // yet / non-review-app repo) → no bit.
  const reviewBit = ctx.reviewAppUrl ? osc8(ctx.reviewAppUrl, "↗ review-app") : null;

  const bits = [pillBit, linked, groupingBit, wBit, reviewBit].filter((b): b is string => !!b);
  return bits.join(SEP);
}

/**
 * The live-session meters line (line 2) — rendered from the Claude Code statusline PAYLOAD, not the
 * ccs catalogue: model badge, reasoning effort (+ fast-mode), context-window gauge, session cost.
 * Styled in the SAME palette as the TUI list (model color from `familyOf`, cost from `costColor`,
 * fill from `fullnessColor`) so the statusline reads as one system with ccs. Every field is optional
 * and absent ones drop out cleanly (early session, model without effort, non-gateway model, …).
 * Pure/testable: the caller parses the payload into this typed input.
 */
export interface MetersInput {
  /** Raw model id (e.g. `claude-opus-4-8`, `gpt-5.6-sol-…`) — drives the family COLOR. */
  modelId?: string | null;
  /** Display label (Claude Code's `model.display_name`, e.g. `Opus 4.8`). Falls back to the family
   * short label when absent. */
  modelLabel?: string | null;
  /** Reasoning effort level (`high`/`medium`/`low`), when the model exposes it. */
  effort?: string | null;
  /** Whether /fast is active. */
  fast?: boolean;
  /** Context-window used percentage (0–100), or null before the first API response of a turn. */
  ctxPercent?: number | null;
  /** Context-window size in tokens (200000 / 1000000) — rendered as `200k` / `1M`. */
  ctxSize?: number | null;
  /** Session cost so far, USD. */
  costUsd?: number | null;
  /** Number of subagent runs this session spawned (0/absent → the bit is omitted). */
  subagentCount?: number | null;
  /** Summed cost of those subagent runs, USD. */
  subagentUsd?: number | null;
}

const METER_FAINT = theme.faint; // labels, empty gauge cells
const METER_MUTED = theme.muted; // effort label

/** `1M` / `200k` for a context-window token size. */
function ctxWindowLabel(size: number): string {
  if (size >= 1_000_000) return `${Math.round(size / 1_000_000)}M`;
  if (size >= 1000) return `${Math.round(size / 1000)}k`;
  return String(size);
}

/** A 16-cell block gauge: filled portion in the fullness color, remainder faint. Wide enough that
 * each cell is ~6%, so the bar reads as a real meter rather than a coarse 4-step indicator. */
function ctxGauge(pct: number): string {
  const cells = 16;
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
  return colorize("█".repeat(filled), fullnessColor(pct)) + colorize("░".repeat(cells - filled), METER_FAINT);
}

/** Render the meters line from a parsed payload. Returns "" when nothing is known yet (caller then
 * emits only the identity line). Bits are joined with the same SEP gap as the identity line. */
export function renderMeters(m: MetersInput): string {
  const modelBit =
    m.modelLabel || m.modelId
      ? colorize(m.modelLabel ?? familyOf(m.modelId ?? "").label, familyOf(m.modelId ?? "").color)
      : null;

  let effortBit: string | null = null;
  if (m.effort || m.fast) {
    const parts: string[] = [];
    if (m.effort) parts.push(colorize(m.effort, METER_MUTED));
    if (m.fast) parts.push(colorize("⚡fast", theme.costMid));
    effortBit = parts.join(" ");
  }

  let ctxBit: string | null = null;
  if (typeof m.ctxPercent === "number") {
    const pct = Math.max(0, Math.round(m.ctxPercent));
    const size = m.ctxSize ? ` ${colorize(ctxWindowLabel(m.ctxSize), METER_FAINT)}` : "";
    ctxBit = `${colorize("ctx", METER_FAINT)} ${ctxGauge(pct)} ${colorize(`${pct}%`, fullnessColor(pct))}${size}`;
  }

  const costBit =
    typeof m.costUsd === "number" && m.costUsd > 0
      ? colorize(formatCost(m.costUsd), costColor(m.costUsd))
      : null;

  // Subagent rollup, in the TUI's own vocabulary: `↳N` child count in faint, their summed spend
  // graded by the cost ramp. Omitted entirely for a session that spawned none, so ordinary
  // sessions don't carry a dead `↳0`.
  let subBit: string | null = null;
  if (typeof m.subagentCount === "number" && m.subagentCount > 0) {
    const count = colorize(`↳${m.subagentCount}`, METER_FAINT);
    const usd =
      typeof m.subagentUsd === "number" && m.subagentUsd > 0
        ? ` ${colorize(formatCost(m.subagentUsd), costColor(m.subagentUsd))}`
        : "";
    subBit = `${count}${usd}`;
  }

  const bits = [modelBit, effortBit, ctxBit, costBit, subBit].filter((b): b is string => !!b);
  return bits.join(SEP);
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
