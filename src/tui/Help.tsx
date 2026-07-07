import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.ts";

export interface KeyGroup {
  name: string;
  keys: Array<[string, string]>;
}

/**
 * Grouped keybinding reference. Footers stay minimal (most-used keys + `?`);
 * this overlay is the complete, organized map — shared by both TUI modes.
 */
export function KeyHelp({ title, groups }: { title: string; groups: KeyGroup[] }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={1}>
      <Text bold color={theme.accent}>
        {title}
      </Text>
      {groups.map((group) => (
        <Box key={group.name} flexDirection="column" marginTop={1}>
          <Text bold color={theme.header}>
            {group.name}
          </Text>
          {group.keys.map(([k, desc], i) => (
            <Box key={i}>
              <Box width={14} flexShrink={0}>
                <Text color="white" bold>
                  {"  "}
                  {k}
                </Text>
              </Box>
              <Text color={theme.muted} wrap="truncate-end">
                {desc}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={theme.faint}>press ? or esc to close</Text>
      </Box>
    </Box>
  );
}

const SESSION_GROUPS: KeyGroup[] = [
  {
    name: "Move",
    keys: [
      ["↑↓ / j k", "move selection"],
      ["→ ← / l h", "expand / collapse (sections, subagent runs)"],
    ],
  },
  {
    name: "Resume",
    keys: [
      ["↵", "resume the session (on a section header: expand/collapse)"],
      ["f", "fork-resume (new session id, same history)"],
      ["o", "resume via the other target (inline ↔ cmux)"],
    ],
  },
  {
    name: "Inspect",
    keys: [
      ["v", "read the full transcript (j/k, PgUp/PgDn, g/G)"],
      ["p", "show / hide the preview pane"],
    ],
  },
  {
    name: "Find & arrange",
    keys: [
      ["/", "search — fuzzy title/project + full-text content"],
      ["g", "change grouping: groups → by-state → flat → tree"],
      ["s", "change sort: recency → cost → messages"],
      ["a", "show / hide subagent runs"],
      ["A", "show / hide archived sessions"],
      ["esc", "clear search or skill-pin; when clear, quit"],
    ],
  },
  {
    name: "Organize",
    keys: [
      ["t", "re-title this session"],
      ["L / C / X", "mark as loop / done / archived"],
      ["e", "edit this session's metadata in plain English (codex)"],
      [":", "reorganize metadata across ALL sessions in plain English (codex)"],
    ],
  },
  {
    name: "Modes",
    keys: [
      ["Tab", "switch to SKILLS mode (Tab there returns)"],
      ["?", "this help"],
      ["q", "quit"],
    ],
  },
];

/** Full keybinding reference for the sessions mode, toggled with `?`. */
export function Help(): React.ReactElement {
  return <KeyHelp title="Sessions — keys" groups={SESSION_GROUPS} />;
}
