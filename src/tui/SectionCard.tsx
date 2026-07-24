import React from "react";
import { Box, Text } from "ink";
import { theme, costColor } from "./theme.ts";
import { formatCost } from "../cost.ts";

const BLURB: Record<string, string> = {
  active: "Sessions currently open in a live cmux window.",
  loops: "Standing self-pacing loops — the always-on fleet.",
  parked: "Deferred into a Todoist task; pick up when ready.",
  recent: "Idle but touched in the last two weeks.",
  stale: "No activity in over two weeks.",
  done: "Marked complete.",
  archived: "Hidden from the working set.",
};

/**
 * Detail pane for a selected section header. Rendered in place of the session Preview so the
 * layout never collapses when the cursor lands on a divider (panels must not move on focus).
 */
export function SectionCard({
  name,
  glyph,
  count,
  cost,
  sectionKey,
  height,
  width,
}: {
  name: string;
  glyph: string;
  count: number;
  cost: number;
  sectionKey: string;
  height: number;
  width: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.faint} paddingX={1} width={width} height={height}>
      <Text bold color={theme.header}>
        {glyph !== " " ? `${glyph} ` : ""}
        {name}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Box width={9} flexShrink={0}>
            <Text color={theme.muted}>sessions</Text>
          </Box>
          <Text color={theme.title}>{count}</Text>
        </Box>
        <Box>
          <Box width={9} flexShrink={0}>
            <Text color={theme.muted}>spend</Text>
          </Box>
          <Text color={costColor(cost)}>{formatCost(cost) || "$0"}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.faint} wrap="truncate-end">
          {BLURB[sectionKey] ?? ""}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.faint}>↵ expand / collapse</Text>
      </Box>
    </Box>
  );
}
