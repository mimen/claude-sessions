import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.ts";
import type { SessionRow } from "../index/index.ts";
import type { Route } from "../resume/launchers.ts";
import { familyOf, formatCostList } from "./format.ts";
import { formatAge } from "../store.ts";

/**
 * The `r` overlay: "what you'd be resuming" (session summary) above the resume routes
 * (one row per configured launcher, ineligible ones dimmed with the reason). Pure render —
 * App owns the selection state and the keyboard.
 */
export interface RoutePickerProps {
  row: SessionRow;
  routes: readonly Route[];
  /** Launcher name of the origin-backend default route (pre-selected). */
  defaultName: string | null;
  /** Index into `routes` of the highlighted option. */
  selected: number;
  /** The session is already live — enter focuses its tab; routes are informational only. */
  live: boolean;
  /** Where a resume would land ("cmux" | "inline"), for the footer hint. */
  target: string;
}

export function RoutePicker({ row, routes, defaultName, selected, live, target }: RoutePickerProps): React.ReactElement {
  const models = row.models.length > 0 ? row.models : null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={1}>
      <Text bold color={theme.accent}>
        Resume — {row.title}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Box width={9} flexShrink={0}><Text color={theme.muted}>repo</Text></Box>
          <Text wrap="truncate-end">{row.projectName}  ({row.branch ?? "-"})</Text>
        </Box>
        <Box>
          <Box width={9} flexShrink={0}><Text color={theme.muted}>cwd</Text></Box>
          <Text wrap="truncate-end" color={theme.muted}>{row.cwd ?? "(unknown)"}</Text>
        </Box>
        <Box>
          <Box width={9} flexShrink={0}><Text color={theme.muted}>activity</Text></Box>
          <Text>
            {row.msgCount} msgs · {formatAge(row.lastTs) || "-"}
            {row.costUSD > 0 ? ` · ${formatCostList(row.costUSD)}` : ""}
          </Text>
        </Box>
        <Box>
          <Box width={9} flexShrink={0}><Text color={theme.muted}>models</Text></Box>
          {models ? (
            <Text wrap="truncate-end">
              {models.map((m, i) => (
                <Text key={m}>
                  {i > 0 ? <Text color={theme.faint}> · </Text> : null}
                  <Text color={familyOf(m).color}>{m}</Text>
                </Text>
              ))}
            </Text>
          ) : (
            <Text color={theme.muted}>(no assistant turns yet)</Text>
          )}
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.header}>
          {live ? "already live — enter switches to its tab" : "resume via"}
        </Text>
        {routes.map((r, i) => {
          const sel = i === selected && !live;
          const isDefault = r.launcher.name === defaultName;
          const nameColor = sel ? theme.selFg : r.eligible ? theme.title : theme.faint;
          return (
            <Box key={r.launcher.name} backgroundColor={sel ? theme.selBg : undefined}>
              <Text color={sel ? theme.selFg : theme.accent}>{sel ? "❯ " : "  "}</Text>
              <Box width={12} flexShrink={0}>
                <Text color={nameColor} bold={sel}>
                  {r.eligible ? "✓" : "✗"} {r.launcher.name}
                </Text>
              </Box>
              <Box width={16} flexShrink={0}>
                <Text color={r.eligible ? theme.muted : theme.faint}>{r.launcher.binary}</Text>
              </Box>
              <Text color={r.eligible ? theme.muted : theme.faint} wrap="truncate-end">
                {isDefault ? "(default) " : ""}
                {r.reason ?? ""}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.faint}>
          {live
            ? "enter focus · esc close"
            : `enter resume (${target}) · f fork · o other target · j/k select · esc close`}
        </Text>
      </Box>
    </Box>
  );
}
