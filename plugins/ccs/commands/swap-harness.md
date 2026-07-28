---
description: Swap this session's capability envelope in place (claudex <-> claude-native), keeping its tab, title, and history
argument-hint: "--to <claudex|claude-native> [--model <canonical-model-id>]"
allowed-tools: Bash(ccs:*)
---

# Swap this session's harness

**First check whether this command is the right tool.** It is not, if the user only wants a
different model. `claudex` is one process reaching both vendors, so switching between Claude and
GPT models is `/model` typed in this session — no relaunch, no lost tab, nothing to plan. Say so
and stop.

What a swap still changes, and the only reason to run it, is the **capability envelope** of the
process:

| Harness | Vendors reachable | claude.ai connectors | Remote Control |
| --- | --- | --- | --- |
| `claudex` | Claude + GPT | no | no |
| `claude-native` | Claude only | yes | yes |

So the two swaps that make sense are `claudex → claude-native` (to get connectors and Remote
Control back, at the cost of GPT models) and `claude-native → claudex` (the reverse trade).
`claude-gpt` still exists for older GPT-only transcripts but is deprecated — do not send a session
there unless the user names it.

Transcripts are stored in Anthropic format whichever harness wrote them, so any of them can replay
another's history — the swap changes the launcher, not the data.

The swap happens IN PLACE, via `cmux respawn-pane`. Nothing is closed: the workspace, tab, title,
dock slot, CCS catalogue row, and cmux surface all survive, and the session keeps its full
conversation. What ends is the current process — cmux hangs it up (SIGHUP) and starts the other
harness on the same transcript.

The user's explicit `/ccs:swap-harness` invocation authorizes replacing this session's process.
Do not call `cmux respawn-pane` yourself, and never aim a swap at a surface, workspace, or session
id other than the one `ccs` proves is the current one.

1. **Preflight, always with an explicit `--to`.** More than two launchers are configured, so
   "the other one" is not defined and a bare run is refused by design. Name the target:

   ```
   ccs swap-harness --to claude-native
   ```

   If the user did not say which harness they want, ask before running anything — the answer is a
   capability trade, not a detail you can pick for them.

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
   - `ambiguous-target` — you ran it bare. Re-run with `--to`.
   - `unknown-launcher` — the name is not in `[[launcher]]` config; the message lists what is.
   - `same-harness` — the session is provably already there. This only fires when exactly one
     configured launcher could have produced the transcript; with `claudex` in the fleet the model
     history usually cannot tell `claudex` from `claude-native`, so the swap is permitted and the
     printed `from:` may read as a guess. Trust the user's stated harness over the inferred one.
   - `origin-unknown` — no assistant turns yet, so nothing to infer from. `--to` already covers it.

3. **Show the user the plan and confirm the model.** The defaults are `opus` for both `claudex` and
   `claude-native`, and `gpt-5.6-sol` for `claude-gpt`. A swap always pins a model, because the
   settings alias would otherwise resolve against the harness just left. If they want a different
   one, re-run the preflight with a canonical birth-model ID in `--model`; launcher spellings such
   as `[1m]` are compiled by ccs, and a target that cannot reach the model is refused.

4. **Swap.** Once the user is happy with the printed plan:

   ```
   ccs swap-harness --to claude-native --do
   ```

   Repeat the same `--to` / `--model` flags used in the preflight.

5. **Expect no reply.** `--do` replaces the process running this very command, so the tool call
   will usually not return output and the conversation will not continue in this turn. That is the
   expected success behavior, not an error. The session comes back in the same tab, on the other
   harness, with its history intact — the user picks up from there.
