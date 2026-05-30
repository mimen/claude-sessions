import React from "react";
import { Box, Text } from "ink";
import type { DisplayItem } from "./groupByProject.ts";
import { formatAge } from "../store.ts";

interface SessionListProps {
  items: DisplayItem[];
  selected: number;
  height: number;
}

const SOURCE_MARK = { native: "★", codex: "✎", fallback: "·" } as const;

function pad(text: string, width: number): string {
  if (text.length > width) return text.slice(0, width - 1) + "…";
  return text.padEnd(width);
}

/** Scrolling list of Project headers and Sessions with a selection cursor. */
export function SessionList({ items, selected, height }: SessionListProps): React.ReactElement {
  // Keep the selection within a scrolling window of `height` rows.
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  const window = items.slice(Math.max(0, start), Math.max(0, start) + height);
  const offset = Math.max(0, start);

  return (
    <Box flexDirection="column">
      {window.map((item, i) => {
        const index = offset + i;
        const isSel = index === selected;
        const cursor = isSel ? "❯ " : "  ";

        if (item.kind === "header") {
          const caret = item.expanded ? "▾" : "▸";
          return (
            <Text key={index} bold color={isSel ? "cyan" : "blue"}>
              {cursor}
              {caret} {item.group.name}{" "}
              <Text color="gray">({item.group.sessions.length})</Text>
            </Text>
          );
        }

        const r = item.row;
        const mark = SOURCE_MARK[r.titleSource];
        const indent = "  ".repeat(item.depth);
        const caret = item.childCount > 0 ? (item.expanded ? "▾ " : "▸ ") : "";
        const agents = item.childCount > 0 ? ` ⤷${item.childCount}` : "";
        const sub = r.isSubagent ? "↳ " : "";
        const line = `${indent}${caret}${mark} ${sub}${pad(r.title, 46)} ${pad(r.projectName, 16)} ${pad(r.branch ?? "-", 9)} ${formatAge(r.lastTs)}${agents}`;
        return (
          <Text key={index} color={isSel ? "cyan" : undefined} dimColor={r.isSubagent && !isSel}>
            {cursor}
            {line}
          </Text>
        );
      })}
    </Box>
  );
}
