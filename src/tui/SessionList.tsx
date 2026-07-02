import React from "react";
import { Box, Text } from "ink";
import type { DisplayItem } from "./groupByProject.ts";
import { formatAge } from "../store.ts";
import { formatCost } from "../cost.ts";
import { theme, isRecentAge } from "./theme.ts";

/** Per-row visual style: state glyph + title color + nudge flag (computed in App). */
interface SessionBadge {
  glyph: string;
  color: string;
  nudge: boolean;
  /** Event slug this session is assigned to (catalogue.event), if any. */
  event?: string | null;
}

interface SessionListProps {
  items: DisplayItem[];
  selected: number;
  height: number;
  /** sessionId -> visual style derived from catalogue lifecycle × live open-state. */
  deco?: Map<string, SessionBadge>;
}

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

        // State-grouping section header (Active / Loops / Parked / …).
        if (item.kind === "section") {
          const s = item.section;
          return (
            <Box key={index} backgroundColor={bg}>
              <Text color={sel ? theme.selFg : theme.accent}>{sel ? "❯ " : "  "}</Text>
              <Text bold color={sel ? theme.selFg : theme.header}>
                {item.collapsed ? "▸ " : "▾ "}
                {s.glyph !== " " ? s.glyph + " " : ""}
                {s.name}
              </Text>
              <Text color={sel ? theme.selFg : theme.muted}>
                {" · "}
                {item.count}
                {item.collapsed ? "  [expand]" : ""}
              </Text>
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
        const glyph = badge?.glyph ?? " ";
        const glyphColor = sel ? theme.selFg : badge?.color ?? theme.muted;
        const titleColor = sel ? theme.selFg : r.isSubagent ? theme.muted : badge?.color ?? theme.title;
        const caret = item.childCount > 0 ? (item.expanded ? "▾ " : "▸ ") : "";

        return (
          <Box key={index} backgroundColor={bg}>
            <Text color={sel ? theme.selFg : theme.accent}>{sel ? "❯" : " "}</Text>
            {item.depth > 0 ? <Text>{" ".repeat(item.depth * 2)}</Text> : null}
            <Box width={2} flexShrink={0}>
              <Text color={glyphColor}>{glyph}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} marginRight={1} overflow="hidden">
              <Text wrap="truncate-end" color={titleColor} bold={sel}>
                {caret}
                {r.isSubagent ? "↳ " : ""}
                {r.title}
              </Text>
            </Box>
            {badge?.event ? (
              <Box flexShrink={0} marginRight={1}>
                <Text color={sel ? theme.selFg : theme.project}>⊞{badge.event}</Text>
              </Box>
            ) : null}
            <Box width={5} flexShrink={0} justifyContent="flex-end">
              <Text color={ageColor}>{age}</Text>
            </Box>
            <Box width={8} flexShrink={0} justifyContent="flex-end">
              <Text color={sel ? theme.selFg : theme.muted}>{formatCost(r.costUSD)}</Text>
            </Box>
            <Box width={5} flexShrink={0} justifyContent="flex-end">
              <Text color={sel ? theme.selFg : theme.accent}>
                {item.childCount > 0 ? `⤷${item.childCount}` : ""}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
