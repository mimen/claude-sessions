---
description: Safely close the cmux workspace containing the current CCS session after exact identity checks
allowed-tools: Bash(ccs:*)
---

# Close this session's workspace

Closing a cmux workspace removes the live presentation and stops the process in it. The
CCS catalogue row and transcript survive, so the session can still be found and resumed.

The user's explicit `/ccs:close-workspace` invocation authorizes closing this workspace.
Do not close any workspace through cmux directly, by title, by cwd, by numeric workspace
reference, or by whichever tab is focused.

1. **Preflight the exact current workspace.**
   ```
   ccs close-current-workspace
   ```
   The command must prove that the Claude session ID, cmux surface UUID, hook-store
   binding, and cmux workspace UUID all agree; that this session owns the tab; and that
   its terminal is the workspace's only live surface. Extra shells, browser panes,
   untracked agents, or other surfaces make the command refuse.

2. **Stop on any refusal.** Report the structured refusal reason. Never guess, fall back,
   retry against another target, or invoke `cmux close-workspace` yourself. Refusal is
   safer than closing the wrong workspace.

3. **Close after a fresh double-check.** If preflight reports `authorized`, run:
   ```
   ccs close-current-workspace --do
   ```
   The command takes two fresh live-state snapshots before it closes the stable workspace
   UUID. The workspace may disappear before a final response can be printed; that is the
   expected success behavior.
