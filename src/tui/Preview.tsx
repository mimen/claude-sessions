import React from "react";
import { Box, Text } from "ink";
import type { SessionRow } from "../index/index.ts";
import { formatBytes, formatAge } from "../store.ts";
import { theme } from "./theme.ts";

interface PreviewProps {
  row: SessionRow;
  skeleton: string;
  parentTitle: string | null;
  subagentCount: number;
  /** Total height available to the pane (border included). */
  height: number;
}

const SOURCE_COLOR = {
  native: theme.sourceNative,
  codex: theme.sourceCodex,
  fallback: theme.sourceFallback,
} as const;

function fmtTs(iso: string | null): string {
  if (!iso) return "?";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function Field({ label, value, color }: { label: string; value: string; color?: string }): React.ReactElement {
  return (
    <Box>
      <Box width={9} flexShrink={0}>
        <Text color={theme.muted}>{label}</Text>
      </Box>
      <Text color={color ?? theme.title} wrap="truncate-end">
        {value}
      </Text>
    </Box>
  );
}

/** Detail pane for the selected Session — styled label/value rows + a content peek. */
export function Preview({ row, skeleton, parentTitle, subagentCount, height }: PreviewProps): React.ReactElement {
  const fixedRows = 8 + (row.isSubagent && parentTitle ? 1 : 0) + (subagentCount > 0 ? 1 : 0);
  const peekLines = Math.max(0, height - fixedRows);
  const peek = peekLines > 0 ? skeleton.split("\n").slice(0, peekLines) : [];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.faint} paddingX={1} height={height}>
      <Text bold color={SOURCE_COLOR[row.titleSource]} wrap="truncate-end">
        {row.title}
      </Text>
      <Text color={theme.muted}>
        {row.titleSource} title · {row.msgCount} msgs · {formatBytes(row.fileSize)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Field label="project" value={`${row.projectName}  (${row.branch ?? "-"})`} color={theme.accent} />
        <Field label="cwd" value={row.cwd ?? "(unknown)"} />
        <Field label="version" value={row.version ?? "?"} />
        <Field label="started" value={fmtTs(row.firstTs)} />
        <Field label="active" value={`${fmtTs(row.lastTs)}  (${formatAge(row.lastTs)})`} />
        <Field label="id" value={row.sessionId} />
        {row.isSubagent && parentTitle ? (
          <Field label="parent" value={parentTitle} color="yellow" />
        ) : null}
        {subagentCount > 0 ? (
          <Field label="agents" value={`${subagentCount} subagent run${subagentCount === 1 ? "" : "s"}`} color={theme.accent} />
        ) : null}
      </Box>
      {peek.length ? (
        <Box flexDirection="column" marginTop={1}>
          {peek.map((line, i) => (
            <Text key={i} color={theme.faint} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
