import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.ts";

const KEYS: Array<[string, string]> = [
  ["↑ ↓ / j k", "move selection"],
  ["↵", "resume session (or expand a project group)"],
  ["→ / l", "drill into a session's subagent runs"],
  ["← / h", "collapse subagent runs"],
  ["f", "fork-resume (--fork-session)"],
  ["o", "resume via the other target (inline ↔ cmux)"],
  ["v", "view full transcript (↑↓/PgUp/PgDn/g/G to scroll)"],
  ["/", "search (fuzzy title/project + content)"],
  ["esc", "clear search filter, then quit"],
  ["g", "toggle group-by-project"],
  ["p", "toggle preview pane"],
  ["a", "show / hide subagent runs"],
  ["t", "re-title the selected session"],
  ["? ", "toggle this help"],
  ["q", "quit"],
];

/** Full keybinding reference, toggled with `?`. */
export function Help(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={1}>
      <Text bold color={theme.accent}>
        Keys
      </Text>
      <Box marginTop={1} flexDirection="column">
        {KEYS.map(([k, desc], i) => (
          <Box key={i}>
            <Box width={14} flexShrink={0}>
              <Text color="white" bold>
                {k}
              </Text>
            </Box>
            <Text color={theme.muted}>{desc}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>press ? or esc to close</Text>
      </Box>
    </Box>
  );
}
