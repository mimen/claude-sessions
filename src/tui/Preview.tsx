import React from "react";
import { Box, Text } from "ink";
import type { SessionRow } from "../index/index.ts";
import { formatBytes, formatAge } from "../store.ts";
import { formatCost } from "../cost.ts";
import { theme, costColor } from "./theme.ts";
import { formatTokens, modelBreakdown, formatDuration, burnPerDay } from "./format.ts";

interface PreviewProps {
  row: SessionRow;
  skeleton: string;
  parentTitle: string | null;
  subagentCount: number;
  /** Summed cost of this Session's subagent runs (0 if none). */
  subagentCost: number;
  /** Catalogue classification for the selected session. */
  event?: string | null;
  skill?: string | null;
  project?: string | null;
  kind?: "session" | "loop";
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
    <Box flexShrink={0}>
      <Box width={9} flexShrink={0}>
        <Text color={theme.muted}>{label}</Text>
      </Box>
      <Text color={color ?? theme.title} wrap="truncate-end">
        {value}
      </Text>
    </Box>
  );
}

/**
 * Detail pane for the selected Session — metadata, classification, a cost/token panel, and a
 * content peek. The fixed blocks never shrink; the peek flex-grows and clips (overflow hidden),
 * so content is never hand-counted against `height` (which used to overlap rows when it overran).
 */
export function Preview({
  row,
  skeleton,
  parentTitle,
  subagentCount,
  subagentCost,
  event,
  skill,
  project,
  kind,
  height,
}: PreviewProps): React.ReactElement {
  const models = modelBreakdown(row.costByModel);
  const totalCost = row.costUSD + subagentCost;
  const cacheTok = row.tokCacheRead + row.tokCacheWrite;
  const cadence = formatDuration(row.tickIntervalSec);
  const burn = burnPerDay(totalCost, row.firstTs, row.lastTs);
  const peek = skeleton ? skeleton.split("\n").slice(0, 60) : [];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.faint}
      paddingX={1}
      height={height}
      overflow="hidden"
    >
      <Text bold color={SOURCE_COLOR[row.titleSource]} wrap="truncate-end">
        {row.title}
      </Text>
      <Text color={theme.muted}>
        {row.titleSource} title · {row.msgCount} msgs · {formatBytes(row.fileSize)}
      </Text>

      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        <Field label="repo" value={`${row.projectName}  (${row.branch ?? "-"})`} color={theme.accent} />
        <Field label="cwd" value={row.cwd ?? "(unknown)"} />
        <Field label="started" value={fmtTs(row.firstTs)} />
        <Field label="active" value={`${fmtTs(row.lastTs)}  (${formatAge(row.lastTs)})`} />
        <Field label="version" value={row.version ?? "?"} />
        <Field label="id" value={row.sessionId} />
        {kind === "loop" ? <Field label="kind" value="loop ◆" color={theme.accent} /> : null}
        {skill ? <Field label="skill" value={`⚙ ${skill}`} color={theme.accent} /> : null}
        {project ? <Field label="project" value={`▢ ${project}`} color={theme.header} /> : null}
        {event ? <Field label="event" value={`⊞ ${event}`} color={theme.project} /> : null}
        {row.isSubagent && parentTitle ? <Field label="parent" value={parentTitle} color="yellow" /> : null}
      </Box>

      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        <Box>
          <Box width={9} flexShrink={0}>
            <Text color={theme.muted}>spend</Text>
          </Box>
          <Text bold color={costColor(totalCost)}>
            {formatCost(totalCost) || "$0"}
          </Text>
          {subagentCount > 0 ? (
            <Text color={theme.muted}>
              {"  "}
              {formatCost(row.costUSD) || "$0"} self
            </Text>
          ) : null}
        </Box>
        {subagentCost > 0 ? (
          <Field
            label=""
            value={`+ ${formatCost(subagentCost)} across ${subagentCount} subagent run${subagentCount === 1 ? "" : "s"}`}
            color={theme.accent}
          />
        ) : null}
        <Box>
          <Box width={9} flexShrink={0}>
            <Text color={theme.muted}>tokens</Text>
          </Box>
          <Text color={theme.title} wrap="truncate-end">
            {formatTokens(row.tokInput)} in · {formatTokens(row.tokOutput)} out
            <Text color={theme.muted}> · {formatTokens(cacheTok)} cache</Text>
          </Text>
        </Box>
        {models.slice(0, 3).map((m, i) => (
          <Box key={i}>
            <Box width={9} flexShrink={0}>
              <Text color={theme.muted}>{i === 0 ? "models" : ""}</Text>
            </Box>
            <Text color={m.badge.color}>● {m.badge.label}</Text>
            <Text color={costColor(m.usd)}> {formatCost(m.usd)}</Text>
          </Box>
        ))}
        {burn != null ? (
          <Field label="burn" value={`${formatCost(burn)}/day`} color={costColor(burn * 7)} />
        ) : null}
        {cadence ? (
          <Field label="cadence" value={`~${cadence} · ${row.userTurns} ticks`} color={theme.accent} />
        ) : null}
      </Box>

      {peek.length ? (
        <Box marginTop={1} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
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
