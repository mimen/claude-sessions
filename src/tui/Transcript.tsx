import React from "react";
import { Box, Text } from "ink";
import type { TranscriptLine } from "../transcript.ts";
import { theme } from "./theme.ts";

interface TranscriptProps {
  title: string;
  lines: TranscriptLine[];
  truncated: boolean;
  /** Scroll offset in visual rows. */
  scroll: number;
  width: number;
  height: number;
}

const KIND_COLOR = {
  user: theme.accent,
  assistant: theme.title,
  tool: theme.faint,
  meta: theme.muted,
} as const;

const KIND_LABEL = { user: "you ", assistant: "ai  ", tool: "    ", meta: "" } as const;

/** Hard-wrap a logical line into visual rows at the given width. */
function wrap(text: string, width: number): string[] {
  if (text === "") return [""];
  const rows: string[] = [];
  for (const para of text.split("\n")) {
    let s = para;
    if (s === "") rows.push("");
    while (s.length > width) {
      rows.push(s.slice(0, width));
      s = s.slice(width);
    }
    if (s.length || para === "") rows.push(s);
  }
  return rows;
}

/** Full scrollable transcript view (opened with `v`). */
export function Transcript({ title, lines, truncated, scroll, width, height }: TranscriptProps): React.ReactElement {
  const inner = Math.max(10, width - 8); // room for the role gutter
  const visual: Array<{ kind: TranscriptLine["kind"]; text: string; first: boolean }> = [];
  for (const line of lines) {
    const wrapped = wrap(line.text, inner);
    wrapped.forEach((t, i) => visual.push({ kind: line.kind, text: t, first: i === 0 }));
  }

  const bodyHeight = Math.max(3, height - 2);
  const maxScroll = Math.max(0, visual.length - bodyHeight);
  const clamped = Math.min(scroll, maxScroll);
  const window = visual.slice(clamped, clamped + bodyHeight);
  const atEnd = clamped >= maxScroll;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} height={height}>
      <Text bold color={theme.accent} wrap="truncate-end">
        {title}
        <Text color={theme.muted}> — {visual.length} lines{truncated ? " (truncated)" : ""}</Text>
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {window.map((row, i) => (
          <Box key={i}>
            <Box width={4} flexShrink={0}>
              <Text color={theme.muted}>{row.first ? KIND_LABEL[row.kind] : ""}</Text>
            </Box>
            <Text color={KIND_COLOR[row.kind]}>{row.text || " "}</Text>
          </Box>
        ))}
      </Box>
      <Text color={theme.muted}>
        ↑↓/jk scroll · PgUp/PgDn · {atEnd ? "END" : `${Math.round((clamped / Math.max(1, maxScroll)) * 100)}%`} · v/esc/q close
      </Text>
    </Box>
  );
}
