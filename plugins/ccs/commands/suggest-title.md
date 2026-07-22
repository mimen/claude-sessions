---
description: Generate and apply a title based on what the current session actually became
argument-hint: "[optional hint to bias the title]"
allowed-tools: Bash(ccs:*), Bash(head -30)
---

# Suggest a title from what this session became

Claude Code's native AI title is written near the beginning of a conversation and does
not follow later topic drift. That opening title is often still correct; this command is
for sessions whose dominant purpose changed.

1. **Check whether a new title is warranted.** Run `ccs session .` and
   `ccs ls | head -30`. Treat the recent list as supporting context, not identity proof —
   it has no session IDs and may contain similar rows. If a custom title is present,
   compare it directly; otherwise judge from the opening request and the conversation's
   current dominant purpose. If the purpose did not materially drift, say so and stop.

2. **Write one in CCS house style:**
   - at most 60 characters;
   - imperative mood and sentence case — `Build CCS utility commands for session management`,
     not `Ship A CCS Utility Plugin`;
   - no surrounding quotes or trailing period;
   - describe the session's current dominant purpose, not only its first message;
   - bias toward **$ARGUMENTS** when it is non-empty.

3. **Apply it:**
   ```
   ccs rename . "<generated title>"
   ```

4. **Report** `old → new` and whether cmux synced. The change is reversible:
   `/ccs:title` sets exact wording, and `ccs session unset . --title` clears the custom
   title to fall back to Claude Code's native title.
