import React from "react";
import { Box, Text } from "ink";
import type { DisplayItem } from "./groupByProject.ts";
import { formatAge } from "../store.ts";
import { theme, isRecentAge, costColor, roleColor } from "./theme.ts";
import { modelBadge, formatCostList, formatCompactUSD, identityRowLabel } from "./format.ts";
import { CARET_W, GLYPH_W, PHASE_W, ROLE_W, TASKS_W, MODEL_W, COST_W, AGE_W, SUB_W, TITLE_MR } from "./columns.ts";

/** List cost color: dimmed by default so cost doesn't shout over status/title; only a
 * genuine outlier (≥ the high tier) keeps its warning color. */
function listCostColor(usd: number): string {
  return usd >= 500 ? costColor(usd) : theme.faint;
}

/** Abbreviate a catalogue role (skill) for the narrow role column. */
function roleLabel(role: string | null | undefined): string {
  if (!role) return "";
  return role
    .replace(/^pr-watch-2$/, "concierge")
    .replace(/^pr-watch-/, "")   // pr-watch-control -> control, pr-watch-eval -> eval
    .replace(/^pr-agent$/, "worker")
    .replace(/^review-agent$/, "reviewer")
    .replace(/^loop-designer$/, "designer")
    .slice(0, ROLE_W);
}

/** Per-row visual style: state glyph + title color + nudge flag (computed in App). */
interface SessionBadge {
  glyph: string;
  color: string;
  nudge: boolean;
  /** Durable identity key attached to this session, if any. */
  event?: string | null;
  /** PR number (catalogue.pr_number), shown as a #-badge colored by pr state. */
  pr?: number | null;
  prState?: string | null;
  /** Role (catalogue.skill), shown in the role column. */
  role?: string | null;
  /** Status label (lifecycle × live open-state), shown in the status column. */
  status?: string | null;
  /** Composed state pill label (worker's pipeline state), shown in the stage column. */
  phase?: string | null;
  /** Optional hex color for the stage-column text — matches the cmux tab pill. */
  phaseColor?: string | null;
  /** Claude task list: completed/total counts + interrupted (in_progress but not open). */
  taskDone?: number | null;
  taskTotal?: number | null;
  taskInterrupted?: boolean;
  /** Explicit execution classification warning. */
  classification?: "AUX" | "UNCLASSIFIED" | null;
}

interface SessionListProps {
  items: DisplayItem[];
  selected: number;
  height: number;
  /** Content width — lets section dividers rule out to the full width. */
  width: number;
  /** sessionId -> visual style derived from catalogue lifecycle × live open-state. */
  deco?: Map<string, SessionBadge>;
  /** sessionId -> total spend (own + subagent rollup). Falls back to the row's own cost. */
  totalCost?: Map<string, number>;
  /** Show the STATUS + ROLE columns (cluster view only — they'd steal title width elsewhere). */
  showRoleStatus?: boolean;
  /** Show the TASKS column (wide terminals only; narrow keeps just the interrupted marker). */
  showTasks?: boolean;
}

/** Box-based row layout — column widths are enforced by flexbox, so glyph width never drifts. */
export function SessionList({ items, selected, height, width, deco, totalCost, showRoleStatus, showTasks }: SessionListProps): React.ReactElement {
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  const offset = Math.max(0, start);
  const window = items.slice(offset, offset + height);

  return (
    <Box flexDirection="column">
      {window.map((item, i) => {
        const index = offset + i;
        const sel = index === selected;
        const bg = sel ? theme.selBg : undefined;

        // Section header — a titled divider. `level` nests it (indent + lighter rule for
        // sub-headers), so a hierarchy like cluster ▸ core/workers ▸ epic reads as nested
        // groups instead of a repeated full-path prefix on every line.
        if (item.kind === "section") {
          const s = item.section;
          const level = s.level ?? 0;
          const indent = "  ".repeat(level);
          const glyph = s.glyph !== " " ? `${s.glyph} ` : "";
          const label = `${indent}${item.collapsed ? "▸" : "▾"} ${glyph}${s.name} · ${item.count}${item.collapsed ? " ⋯" : ""}`;
          const ruleLen = Math.max(0, width - CARET_W - label.length - 2);
          // Top-level headers rule out full-width + bold header color; sub-headers are
          // shorter/dimmer so the top of a cluster stands out from its subgroups.
          const nameColor = sel ? theme.selFg : level === 0 ? theme.header : theme.accent;
          const rule = level === 0 ? "─" : "·";
          return (
            <Box key={index} backgroundColor={bg}>
              <Text color={sel ? theme.selFg : theme.accent}>{sel ? "❯" : " "}</Text>
              <Text bold={level === 0} color={nameColor}>
                {label}
              </Text>
              {level === 0 ? (
                <Text color={sel ? theme.selFg : theme.faint}> {rule.repeat(ruleLen)}</Text>
              ) : null}
            </Box>
          );
        }

        // Project-group header (only in the legacy `group-by-project` path).
        if (item.kind === "header") {
          return (
            <Box key={index} backgroundColor={bg}>
              <Text color={sel ? theme.selFg : theme.accent}>{sel ? "❯ " : "  "}</Text>
              <Text bold color={sel ? theme.selFg : theme.header}>
                {item.expanded ? "▾ " : "▸ "}
                {item.group.name}
              </Text>
              <Text color={sel ? theme.selFg : theme.muted}> ({item.group.sessions.length})</Text>
            </Box>
          );
        }

        const r = item.row;
        const age = formatAge(r.lastTs);
        const ageColor = sel ? theme.selFg : isRecentAge(age) ? theme.ageRecent : theme.ageOld;
        const badge = deco?.get(r.sessionId);
        // The leading dot encodes STATUS (so we don't need a whole status column that just
        // repeats "active" on every open row): ● open/active, ○ idle, ✓ completed, · archived,
        // ⏸ parked. Status comes from the badge (lifecycle × live open-state); fall back to the
        // display item's openState when there's no badge.
        const st = badge?.status ?? (item.openState === "open" ? "active" : item.openState === "idle" ? "idle" : "");
        const dotFor = (s: string): { g: string; c: string } => {
          if (s === "active") return { g: "●", c: theme.ageRecent };
          if (s.startsWith("parked")) return { g: "⏸", c: "yellow" };
          if (s === "completed" || s.startsWith("completed")) return { g: "✓", c: theme.faint };
          if (s === "archived") return { g: "·", c: theme.faint };
          if (s === "idle") return { g: "○", c: theme.faint };
          return { g: item.openState ? "○" : "", c: theme.faint };
        };
        const { g: dot, c: dotColor0 } = dotFor(st);
        const dotColor = sel ? theme.selFg : dotColor0;
        // Reserve a 2-cell triangle slot for anything in a hierarchy, so leaves align with their
        // collapsible siblings; flat rows (loops/solo, plain lists) get no slot and sit flush.
        const hasSlot = item.depth > 0 || item.childCount > 0;
        const triangle = item.childCount > 0 ? (item.expanded ? "▾ " : "▸ ") : "  ";
        const titleColor = sel
          ? theme.selFg
          : r.isSubagent || item.openState === "idle"
            ? theme.muted
            : badge?.nudge
              ? "yellowBright"
              : theme.title;

        const cost = totalCost?.get(r.sessionId) ?? r.costUSD;
        const model = modelBadge(r.costByModel, r.models);
        const identityLabel = identityRowLabel(badge?.event);

        return (
          <Box key={index} backgroundColor={bg}>
            <Text color={sel ? theme.selFg : theme.accent}>{sel ? "❯" : " "}</Text>
            {dot ? (
              <Box width={GLYPH_W} flexShrink={0}>
                <Text color={dotColor}>{dot}</Text>
              </Box>
            ) : null}
            <Box flexGrow={1} flexShrink={1} marginRight={TITLE_MR} overflow="hidden">
              <Text wrap="truncate-end" color={titleColor} bold={sel}>
                {"  ".repeat(item.depth)}
                {hasSlot ? <Text color={sel ? theme.selFg : theme.faint}>{triangle}</Text> : null}
                {/* The PR# is shown by the badge; strip any leading #<num> from the
                    title so it never doubles (e.g. "#12137 #12137 …"). */}
                {badge?.pr ? r.title.replace(/^(#\d+\s+)+/, "") : r.title}
              </Text>
            </Box>
            {badge?.classification ? (
              <Box flexShrink={0} marginRight={1}>
                <Text color={sel ? theme.selFg : badge.classification === "AUX" ? theme.accent : "yellow"}>
                  {badge.classification}
                </Text>
              </Box>
            ) : null}
            {badge?.pr ? (
              <Box flexShrink={0} marginRight={1}>
                <Text
                  color={
                    sel
                      ? theme.selFg
                      : badge.prState === "merged"
                        ? theme.sourceNative
                        : badge.prState === "closed"
                          ? theme.faint
                          : theme.accent
                  }
                >
                  #{badge.pr}
                </Text>
              </Box>
            ) : identityLabel ? (
              <Box flexShrink={0} marginRight={1}>
                <Text color={sel ? theme.selFg : theme.project}>⊞{identityLabel}</Text>
              </Box>
            ) : null}
            {showRoleStatus ? (
              <>
                <Box width={PHASE_W} flexShrink={0}>
                  {/* Composed state pill label from board.json, rendered in the pill's own color
                      (matches the cmux tab pill exactly). No pill / no color → theme.accent. */}
                  <Text
                    color={sel ? theme.selFg : (badge?.phaseColor ?? theme.accent)}
                    wrap="truncate-end"
                  >
                    {badge?.phase ?? ""}
                  </Text>
                </Box>
                <Box width={ROLE_W} flexShrink={0}>
                  <Text color={sel ? theme.selFg : roleColor(badge?.role)} wrap="truncate-end">
                    {/* Only non-worker roles carry signal — "worker" is the default 20x over, so
                        blank it. eval/designer/control/concierge stand out, each in its own hue
                        (matching the cmux tab palette) so the role reads at a glance. */}
                    {roleLabel(badge?.role) === "worker" ? "" : roleLabel(badge?.role)}
                  </Text>
                </Box>
              </>
            ) : null}
            {!showTasks && badge?.taskInterrupted ? (
              /* Narrow terminals lose the TASKS column but keep the one signal that matters:
                 this session was abandoned with a task mid-flight. */
              <Box flexShrink={0} marginRight={1}>
                <Text color={sel ? theme.selFg : "yellow"}>!</Text>
              </Box>
            ) : null}
            {showTasks ? (
              <Box width={TASKS_W} flexShrink={0}>
                {badge?.taskTotal ? (
                  <Text
                    color={
                      sel
                        ? theme.selFg
                        : badge.taskInterrupted
                          ? "yellow"
                          : badge.taskDone === badge.taskTotal
                            ? theme.faint
                            : theme.muted
                    }
                    wrap="truncate-end"
                  >
                    ▣ {badge.taskDone}/{badge.taskTotal}
                    {badge.taskInterrupted ? "!" : ""}
                  </Text>
                ) : null}
              </Box>
            ) : null}
            <Box width={MODEL_W} flexShrink={0}>
              <Text color={sel ? theme.selFg : model?.color ?? theme.faint} wrap="truncate-end">
                {model?.label ?? ""}
              </Text>
            </Box>
            <Box width={COST_W} flexShrink={0} justifyContent="flex-end">
              <Text color={sel ? theme.selFg : listCostColor(cost)}>{formatCostList(cost)}</Text>
            </Box>
            <Box width={AGE_W} flexShrink={0} justifyContent="flex-end">
              <Text color={ageColor}>{age}</Text>
            </Box>
            <Box width={SUB_W} flexShrink={0} justifyContent="flex-end">
              {item.subtreeCost != null ? (
                <Text color={sel ? theme.selFg : costColor(item.subtreeCost)}>
                  Σ{formatCompactUSD(item.subtreeCost)}
                </Text>
              ) : (
                <Text color={sel ? theme.selFg : theme.faint}>
                  {item.childCount > 0 ? `⤷${item.childCount}` : ""}
                </Text>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
