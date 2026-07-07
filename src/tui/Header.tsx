import React from "react";
import { Box, Text } from "ink";
import { theme, costColor } from "./theme.ts";
import { formatCompactUSD } from "./format.ts";
import type { SortMode } from "./groupByProject.ts";

/** Aggregate stats for the dashboard header — computed once in App from the visible rows. */
export interface DashStats {
  readonly host: string;
  readonly sessions: number;
  readonly spend: number;
  readonly active: number;
  readonly parked: number;
  readonly loops: number;
  readonly loopSpend: number;
  /** Total spend attributable to subagent runs (otherwise invisible — they're hidden rows). */
  readonly agentSpend: number;
  readonly topTitle: string | null;
  readonly topCost: number;
}

const SORT_LABEL: Record<SortMode, string> = {
  recent: "recency",
  cost: "cost",
  msgs: "messages",
};

function Stat({ label, value, color }: { label: string; value: string; color?: string }): React.ReactElement {
  return (
    <Text>
      <Text color={color ?? theme.headerValue} bold>
        {value}
      </Text>
      <Text color={theme.headerLabel}> {label}</Text>
    </Text>
  );
}

const SEP = <Text color={theme.faint}>{"   "}</Text>;

/**
 * The dashboard header: two dense stat lines, no border. Per TUI convention an outer full-screen
 * frame is redundant chrome; the horizontal rule (drawn by App) separates it from the list.
 */
export function Header({
  stats,
  sort,
  filter,
  titling,
}: {
  stats: DashStats;
  sort: SortMode;
  filter: string | null;
  titling: string | null;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text bold color={theme.accent}>
            ccs
          </Text>
          <Text color={theme.headerLabel}> · {stats.host}</Text>
          {SEP}
          <Stat value={String(stats.sessions)} label="sessions" />
          {SEP}
          <Stat value={formatCompactUSD(stats.spend)} label="spend" color={costColor(stats.spend)} />
          {SEP}
          <Stat value={String(stats.active)} label="active" color={stats.active ? theme.ageRecent : theme.headerValue} />
          {SEP}
          <Stat value={String(stats.parked)} label="parked" color={stats.parked ? "yellow" : theme.headerValue} />
        </Text>
        <Text color={theme.headerLabel}>{titling ?? (filter ? `/${filter}` : `sort · ${SORT_LABEL[sort]}`)}</Text>
      </Box>
      <Text wrap="truncate-end">
        <Stat value={String(stats.loops)} label="loops" color={theme.accent} />
        <Text color={theme.headerLabel}> ({formatCompactUSD(stats.loopSpend)})</Text>
        {SEP}
        <Stat value={formatCompactUSD(stats.agentSpend)} label="in subagents" color={theme.headerValue} />
        {stats.topTitle ? (
          <>
            {SEP}
            <Text color={theme.headerLabel}>top </Text>
            <Text color={costColor(stats.topCost)} bold>
              {formatCompactUSD(stats.topCost)}
            </Text>
            <Text color={theme.headerLabel}> {stats.topTitle}</Text>
          </>
        ) : null}
      </Text>
    </Box>
  );
}
