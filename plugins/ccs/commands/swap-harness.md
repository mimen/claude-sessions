---
description: Move this session to the other harness (claude-native <-> claude-gpt) in place, keeping its tab, title, and history
argument-hint: "[--to <launcher>] [--model <model>]"
allowed-tools: Bash(ccs:*)
---

# Swap this session's harness

A harness is the launcher this session runs on: `claude-native` (real Anthropic) or `claude-gpt`
(the same Claude Code harness pointed at the local gateway, on GPT models). Transcripts are stored
in Anthropic format whichever one wrote them, so either can replay the other's history — the swap
changes the launcher, not the data.

The swap happens IN PLACE, via `cmux respawn-pane`. Nothing is closed: the workspace, tab, title,
dock slot, CCS catalogue row, and cmux surface all survive, and the session keeps its full
conversation. What ends is the current process — cmux hangs it up (SIGHUP) and starts the other
harness on the same transcript.

The user's explicit `/ccs:swap-harness` invocation authorizes replacing this session's process.
Do not call `cmux respawn-pane` yourself, and never aim a swap at a surface, workspace, or session
id other than the one `ccs` proves is the current one.

1. **Preflight.** Pass through whatever the user supplied (`--to`, `--model`); otherwise run it
   bare.

   ```
   ccs swap-harness
   ```

   The command must prove that `CLAUDE_CODE_SESSION_ID`, `CMUX_SURFACE_ID`, and
   `CMUX_WORKSPACE_ID` all agree with cmux's own surface binding before it will plan anything.
   It prints the target harness, the model, the launch cwd it will resume in, the permission mode
   it carries over, and the exact command it would run.

2. **Stop on any refusal.** Report the reason verbatim. Never retry against another target, never
   substitute a workspace reference or a session id, and never fall back to closing the session
   and resuming it — that loses the tab and re-introduces the refusals this path exists to avoid.
   Common refusals and what they mean:
   - `identity-mismatch` / `surface-unbound` — cmux binds this surface to a different session.
     Something is wrong with the session's bookkeeping; investigate, don't force.
   - `liveness-unreadable` — cmux is down or its hook store is unreadable. Fail closed.
   - `origin-unknown` — the session has no assistant turns yet, so its current harness can't be
     inferred. Ask the user which harness they want and pass `--to`.
   - `same-harness` — it is already running there.

3. **Show the user the plan and confirm the model.** The defaults are `opus` for `claude-native`
   and `gpt-5.6-sol` for `claude-gpt`. If they want a different one, re-run the preflight with
   `--model` rather than editing anything by hand.

4. **Swap.** Once the user is happy with the printed plan:

   ```
   ccs swap-harness --do
   ```

   Repeat the same `--to` / `--model` flags used in the preflight.

5. **Expect no reply.** `--do` replaces the process running this very command, so the tool call
   will usually not return output and the conversation will not continue in this turn. That is the
   expected success behavior, not an error. The session comes back in the same tab, on the other
   harness, with its history intact — the user picks up from there.
