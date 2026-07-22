---
description: Archive the current session — keep its title useful, hide it from active CCS views, and offer a safe way to close its cmux tab
argument-hint: "[optional title hint]"
allowed-tools: Bash(ccs:*), Bash(claude-actions cmux-close:*)
---

# Archive this session

Archiving hides a session from `ccs` browse and search, and excludes it from cluster
resumes. It is **reversible** (`/ccs:unarchive`) and never touches the transcript — the
store is the source of truth and `ccs` only writes to its own catalogue.

The goal is a session that still reads well in history a month from now, not merely a
hidden row. Make sure it has a useful title before hiding it.

1. **Confirm there's a session.** Run `ccs whoami`; if it errors
   (`CLAUDE_CODE_SESSION_ID` unset), say so and stop.

2. **Read its current catalogue state.** Run `ccs session .`. If it is not catalogued
   yet, you must establish a row in the next step before archiving it. If a custom title
   is present, judge that title; otherwise use the conversation itself rather than
   guessing which row in `ccs ls` belongs to this session.

3. **Keep or improve the title.** A useful CCS title is imperative, sentence case, no
   trailing period, and at most 60 characters. It describes the session's dominant
   purpose rather than only its opening request. Bias toward **$ARGUMENTS** when present.

   - If the session is uncatalogued, run `ccs rename . "<resolved or improved title>"`
     even when the resolved title is already good; `rename` creates the required row.
   - If it is catalogued, retitle only when the current title is generic, stale, or no
     longer describes the work:
     ```
     ccs rename . "<improved title>"
     ```

4. **Archive it.**
   ```
   ccs session archive .
   ```
   Use this per-session verb, **never** `ccs identity archive` — when the session is
   attached to a core identity, archiving the identity retires the whole responsibility
   rather than this one conversation.

5. **Offer the close.** You are running *inside* the tab being archived, so never close it
   yourself — that races your own response and leaves no confirmation surface. Mint a
   confirmation link instead:
   ```
   claude-actions cmux-close "<session-id from step 1>" "Close: <title>"
   ```
   Render the printed `http://127.0.0.1:8765/a/<id>` URL as a markdown link. If
   `claude-actions` is missing or its server is unreachable, skip this step and say the
   tab needs closing by hand — do not promise a dead link.

6. **Report** one line: whether the title was kept or changed, that the session is
   archived, and the close link when one was created.
