import React from "react";
import { Box, Text } from "ink";
import type { DisplayItem } from "./groupByProject.ts";
import { formatAge } from "../store.ts";
import { theme, isRecentAge } from "./theme.ts";

interface SessionBadge {
  loop: boolean;
  label: string;
  nudge: boolean;
}

interface SessionListProps {
  items: DisplayItem[];
  selected: number;
  height: number;
  /** sessionId -> catalogue badge (loop flag + disposition label). */
  deco?: Map<string, SessionBadge>;
}

const SOURCE_MARK = { native: "★", codex: "✎", fallback: "·" } as const;
const SOURCE_COLOR = {
  native: theme.sourceNative,
  codex: theme.sourceCodex,
  fallback: theme.sourceFallback,
} as const;

/** Box-based row layout — column widths are enforced by flexbox, so glyph width never drifts. */
export function SessionList({ items, selected, height, deco }: SessionListProps): React.ReactElement {
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  const offset = Math.max(0, start);
  const window = items.slice(offset, offset + height);

  return (
    <Box flexDirection="column">
      {window.map((item, i) => {
        const index = offset + i;
        const sel = index === selected;
        const bg = sel ? theme.selBg : undefined;

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
        const titleColor = sel ? theme.selFg : r.isSubagent ? theme.muted : theme.title;
        const caret = item.childCount > 0 ? (item.expanded ? "▾ " : "▸ ") : "";

        const badge = deco?.get(r.sessionId);
        const badgeText = badge ? (badge.loop ? "◆ " : "") + badge.label + (badge.nudge ? "!" : "") : "";
        const badgeColor = sel
          ? theme.selFg
          : badge?.nudge
            ? "yellow"
            : badge?.loop
              ? theme.accent
              : theme.muted;

        return (
          <Box key={index} backgroundColor={bg}>
            <Text color={sel ? theme.selFg : theme.accent}>{sel ? "❯" : " "}</Text>
            {item.depth > 0 ? <Text>{" ".repeat(item.depth * 2)}</Text> : null}
            <Box width={2} flexShrink={0}>
              <Text color={sel ? theme.selFg : SOURCE_COLOR[r.titleSource]}>{SOURCE_MARK[r.titleSource]}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} marginRight={1} overflow="hidden">
              <Text wrap="truncate-end" color={titleColor} bold={sel}>
                {caret}
                {r.isSubagent ? "↳ " : ""}
                {r.title}
              </Text>
            </Box>
            <Box width={15} flexShrink={0} marginRight={1}>
              <Text wrap="truncate-end" color={badgeColor}>
                {badgeText}
              </Text>
            </Box>
            <Box width={14} flexShrink={0} marginRight={1}>
              <Text wrap="truncate-end" color={sel ? theme.selFg : theme.project}>
                {r.projectName}
              </Text>
            </Box>
            <Box width={9} flexShrink={0} marginRight={1}>
              <Text wrap="truncate-end" color={sel ? theme.selFg : theme.branch}>
                {r.branch ?? "-"}
              </Text>
            </Box>
            <Box width={5} flexShrink={0} justifyContent="flex-end">
              <Text color={ageColor}>{age}</Text>
            </Box>
            <Box width={5} flexShrink={0} justifyContent="flex-end">
              <Text color={sel ? theme.selFg : theme.accent}>{item.childCount > 0 ? `⤷${item.childCount}` : ""}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
