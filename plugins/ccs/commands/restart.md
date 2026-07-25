---
description: Relaunch this session in place on the same harness — picks up a newly released model, a newer Claude Code, and a fresh process
argument-hint: "[--model <model>]"
allowed-tools: Bash(ccs:*)
---

# Restart this session

Replaces this session's process without losing the conversation. Same harness, same transcript,
same tab — a new process resuming where the old one stopped.

Three things only a restart can get a long-lived session:

- **A newly released model.** Claude Code resolves an alias like `opus` at STARTUP. A session
  started before a new model shipped stays on the old one for its entire life, no matter what
  settings say. This is why restart passes no `--model` at all: the new process re-resolves the
  alias and picks up whatever is current.
- **A newer Claude Code binary**, for the same reason.
- **A fresh process** — the resident memory of a session that has been running for days.

Nothing is closed: the workspace, tab, title, dock slot, CCS catalogue row, and cmux surface all
survive. To move the session to the *other* harness instead, that's `/ccs:swap-harness`.

The user's explicit `/ccs:restart` invocation authorizes replacing this session's process. Do not
call `cmux respawn-pane` yourself, and never aim it at a surface, workspace, or session id other
than the one `ccs` proves is the current one.

1. **Preflight.**

   ```
   ccs restart
   ```

   The command proves that `CLAUDE_CODE_SESSION_ID`, `CMUX_SURFACE_ID`, and `CMUX_WORKSPACE_ID`
   all agree with cmux's own surface binding before it plans anything. It prints the harness, the
   launch directory it will resume in, the permission mode it carries over, and the exact command.
   Expect `model: (settings default — re-resolved on start)` — that is the point, not a gap.

2. **Stop on any refusal.** Report the reason verbatim. Never retry against another target and
   never fall back to closing and resuming the session — that loses the tab.
   - `identity-mismatch` / `surface-unbound` — cmux binds this surface to a different session.
     Investigate; do not force.
   - `liveness-unreadable` — cmux is down or its hook store is unreadable. Fail closed.
   - `origin-unknown` — the session has no assistant turns yet and more than one harness is
     configured, so its current one can't be inferred. Ask the user and pass `--on`.

3. **Restart.** Once the user has seen the plan:

   ```
   ccs restart --do
   ```

   Only pass `--model` if the user explicitly asked to pin one — the default absence is what makes
   the newest model get picked up.

4. **Expect no reply.** `--do` replaces the process running this very command, so the tool call
   will usually return nothing and the conversation will not continue in this turn. That is the
   expected success behavior, not an error. The session comes back in the same tab with its
   history intact.
