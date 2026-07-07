import React from "react";
import { Box, Text } from "ink";
import { categoryColor, type SkillItem } from "../../skills/view.ts";
import { formatAge } from "../../store.ts";
import { theme, isRecentAge } from "../theme.ts";

export const HOME_W = 15;
export const CAT_W = 13;
export const USAGE_W = 13;
export const AGE_W = 5;

interface SkillsListProps {
  items: SkillItem[];
  selected: number;
  height: number;
  width: number;
  /** In the category view, section headers ARE categories — color them to match the column. */
  sectionsAreCategories?: boolean;
}

/** Windowed list of section dividers + skill rows, mirroring SessionList's layout rules. */
export function SkillsList({ items, selected, height, width, sectionsAreCategories }: SkillsListProps): React.ReactElement {
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  const offset = Math.max(0, start);
  const window = items.slice(offset, offset + height);

  return (
    <Box flexDirection="column">
      {window.map((item, i) => {
        const index = offset + i;
        const sel = index === selected;
        const bg = sel ? theme.selBg : undefined;

        if (item.kind === "section") {
          const label = `${item.collapsed ? "▸" : "▾"} ${item.name} · ${item.count}${item.collapsed ? " ⋯" : ""}`;
          const ruleLen = Math.max(0, width - 1 - label.length - 2);
          const headerColor = sectionsAreCategories
            ? categoryColor(item.key === "uncategorized" ? null : item.key) ?? theme.muted
            : theme.header;
          return (
            <Box key={index} backgroundColor={bg}>
              <Text color={sel ? theme.selFg : theme.accent}>{sel ? "❯" : " "}</Text>
              <Text bold color={sel ? theme.selFg : headerColor}>
                {label}
              </Text>
              <Text color={sel ? theme.selFg : theme.faint}> {"─".repeat(ruleLen)}</Text>
            </Box>
          );
        }

        const r = item.row;
        const u = r.usage;
        const age = u?.lastUsed ? formatAge(u.lastUsed) : "";
        const ageColor = sel ? theme.selFg : isRecentAge(age) ? theme.ageRecent : theme.ageOld;
        const usageStr = u ? `${u.invocations}/${u.commands}/${u.reads}` : "·";
        const usageColor = sel ? theme.selFg : u ? theme.muted : theme.costNil;
        const nameColor = sel ? theme.selFg : u ? theme.title : theme.muted;

        return (
          <Box key={index} backgroundColor={bg}>
            <Text color={sel ? theme.selFg : theme.accent}>{sel ? "❯" : " "}</Text>
            <Box flexGrow={1} flexShrink={1} marginRight={1} overflow="hidden">
              <Text wrap="truncate-end" color={nameColor} bold={sel}>
                {r.rec.name}
                {r.drift ? <Text color={sel ? theme.selFg : "yellow"}> ≠</Text> : null}
              </Text>
            </Box>
            <Box width={HOME_W} flexShrink={0}>
              <Text color={sel ? theme.selFg : theme.project} wrap="truncate-end">
                {r.home}
              </Text>
            </Box>
            <Box width={CAT_W} flexShrink={0}>
              <Text color={sel ? theme.selFg : categoryColor(r.category) ?? theme.faint} wrap="truncate-end">
                {r.category ?? ""}
              </Text>
            </Box>
            <Box width={USAGE_W} flexShrink={0} justifyContent="flex-end">
              <Text color={usageColor}>{usageStr}</Text>
            </Box>
            <Box width={AGE_W} flexShrink={0} justifyContent="flex-end">
              <Text color={ageColor}>{age}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
