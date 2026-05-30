import React from "react";
import { Box, Text } from "ink";
import type { SessionRow } from "../index/index.ts";
import { formatBytes, formatAge } from "../store.ts";

interface PreviewProps {
  row: SessionRow;
  skeleton: string;
  parentTitle: string | null;
  subagentCount: number;
}

function fmtTs(iso: string | null): string {
  if (!iso) return "?";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** Detail pane for the selected Session — enough to confirm it before resuming. */
export function Preview({ row, skeleton, parentTitle, subagentCount }: PreviewProps): React.ReactElement {
  const peek = skeleton.split("\n").slice(0, 10);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text bold wrap="truncate-end">
        {row.title}{" "}
        <Text color="gray">({row.titleSource})</Text>
      </Text>
      <Text color="gray" wrap="truncate-end">
        {row.projectName} · {row.branch ?? "-"} · {row.version ?? "?"} ·{" "}
        {row.msgCount} msgs · {formatBytes(row.fileSize)}
      </Text>
      <Text color="gray" wrap="truncate-end">
        {row.cwd ?? "(unknown cwd)"}
      </Text>
      <Text color="gray">
        started {fmtTs(row.firstTs)} · last active {fmtTs(row.lastTs)} ({formatAge(row.lastTs)})
      </Text>
      <Text color="gray" wrap="truncate-end">
        {row.sessionId}
      </Text>
      {row.isSubagent && parentTitle ? (
        <Text color="yellow" wrap="truncate-end">
          ↳ spawned by: {parentTitle}
        </Text>
      ) : null}
      {subagentCount > 0 ? (
        <Text color="cyan">
          {subagentCount} subagent run{subagentCount === 1 ? "" : "s"}
        </Text>
      ) : null}
      {peek.length ? (
        <Box flexDirection="column" marginTop={1}>
          {peek.map((line, i) => (
            <Text key={i} color="white" dimColor wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
