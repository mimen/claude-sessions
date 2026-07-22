---
description: Set an explicit title on the current session — your words, written verbatim to the ccs catalogue and synced to the cmux tab
argument-hint: "<title>"
allowed-tools: Bash(ccs:*)
---

# Title this session

Your wording, used exactly as given. Nothing rewrites it. Use `/ccs:suggest-title` when you'd
rather have one generated from what the session became.

1. If **$ARGUMENTS** is empty, print the usage (`/ccs:title <title>`) and stop. Do not invent
   a title here — that is `/ccs:suggest-title`'s job, and silently guessing would defeat the
   point of the explicit command.

2. Otherwise:
   ```
   ccs rename . "$ARGUMENTS"
   ```
   This writes `custom_title` to the catalogue keyed on `$CLAUDE_CODE_SESSION_ID`, and renames
   the cmux workspace too when the session is open in one.

3. Report the one-line result, including whether cmux synced.
