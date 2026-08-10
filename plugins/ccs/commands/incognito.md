---
description: Mark this session incognito — hidden from every ccs listing, never enriched, never composed into another session's context
argument-hint: "[--off]"
allowed-tools: Bash(ccs:*)
---

# Make this session incognito

Incognito is a per-session property, not a lifecycle state. A marked session is absent from
`ccs ls`, the TUI, the sidebar, the board, category analytics, and the doctor report — with no
flag that reveals it, unlike `archived`, which `--all` shows. It is also excluded from the three
paths that move a session's content somewhere else: the enrichment sweep (which POSTs a
transcript tail to the model gateway), the predecessor lineage another session rehydrates from,
and the world-state block composed into another session's prompt.

The transcript itself is untouched and still on disk. Incognito hides a session; `/ccs:destroy`
is what erases one.

1. If **$ARGUMENTS** contains `--off`, run:
   ```
   ccs session incognito . --off
   ```
   Then report that the session will reappear in listings, and that the enrichment summary
   cleared when it was marked does not come back.

2. Otherwise:
   ```
   ccs session incognito .
   ```

3. Say plainly what changed in one line.

**Marking now is later than birth.** The sweep may already have summarized this transcript and
sent it to the gateway; the command clears what was stored locally, which is the only half that
can still be undone. When the user wants a session that was never seen at all, the airtight path
is to be born hidden: `ccs session new --top-level --incognito …`. Say so if they mark a session
that has already been running a while.
