import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.ts";

export interface ReaderState {
  skillName: string;
  files: string[]; // relative paths, SKILL.md first
  fileIndex: number;
  lines: string[];
  scroll: number;
}

interface SkillReaderProps {
  reader: ReaderState;
  width: number;
  height: number;
}

/** Full-screen file reader for a skill dir. Tab/←→ cycle files; j/k scroll (handled in panel). */
export function SkillReader({ reader, width, height }: SkillReaderProps): React.ReactElement {
  const bodyHeight = Math.max(1, height - 2);
  const visible = reader.lines.slice(reader.scroll, reader.scroll + bodyHeight);
  const file = reader.files[reader.fileIndex] ?? "";
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box>
        <Text bold color={theme.title}>
          {reader.skillName}
        </Text>
        <Text color={theme.muted}> · </Text>
        {reader.files.map((f, i) => (
          <Text key={f} color={i === reader.fileIndex ? theme.accent : theme.faint} bold={i === reader.fileIndex}>
            {i > 0 ? "  " : ""}
            {f}
          </Text>
        ))}
      </Box>
      <Text color={theme.headerBorder}>{"─".repeat(Math.max(0, width))}</Text>
      {visible.map((line, i) => {
        const isHeading = /^#{1,6} /.test(line);
        return (
          <Text key={reader.scroll + i} color={isHeading ? theme.header : theme.title} bold={isHeading} wrap="truncate-end">
            {line || " "}
          </Text>
        );
      })}
      {visible.length === 0 ? <Text color={theme.muted}>(empty file — Tab for next file, q to close)</Text> : null}
    </Box>
  );
}
