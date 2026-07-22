import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.ts";
import type { SortMode } from "./groupByProject.ts";
import { CARET_W, GLYPH_W, PHASE_W, ROLE_W, TASKS_W, MODEL_W, COST_W, AGE_W, SUB_W, TITLE_MR } from "./columns.ts";

const ARROW = "▾";

function Head({
  label,
  width,
  align = "flex-start",
  active,
}: {
  label: string;
  width: number;
  align?: "flex-start" | "flex-end";
  active?: boolean;
}): React.ReactElement {
  return (
    <Box width={width} flexShrink={0} justifyContent={align}>
      <Text color={active ? theme.accent : theme.faint} bold={active}>
        {active ? `${label}${ARROW}` : label}
      </Text>
    </Box>
  );
}

/** Column-header row for the session list. Widths mirror SessionList exactly (see columns.ts). */
export function ListHeader({ sort, view, showTasks }: { sort: SortMode; view: "groups" | "state" | "flat" | "tree" | "cluster" | "epic"; showTasks?: boolean }): React.ReactElement {
  const tree = view === "tree";
  const roleStatus = view === "cluster";
  return (
    <Box>
      <Box width={CARET_W + GLYPH_W} flexShrink={0} />
      <Box flexGrow={1} flexShrink={1} marginRight={TITLE_MR} overflow="hidden">
        <Text color={theme.faint}>{tree ? "CONSTELLATION" : "SESSION"}</Text>
      </Box>
      {roleStatus ? <Head label="PHASE" width={PHASE_W} /> : null}
      {roleStatus ? <Head label="ROLE" width={ROLE_W} /> : null}
      {showTasks ? <Head label="TASKS" width={TASKS_W} /> : null}
      <Head label="MODEL" width={MODEL_W} />
      <Head label="COST" width={COST_W} align="flex-end" active={sort === "cost"} />
      <Head label="AGE" width={AGE_W} align="flex-end" active={sort === "recent"} />
      <Head label={tree ? "Σ" : "↳"} width={SUB_W} align="flex-end" />
    </Box>
  );
}
