# Use the Codex CLI (OpenAI) to generate Session titles

This is a tool for Claude Code sessions, so the obvious titler is `claude -p`. We
deliberately use the `codex exec` CLI instead, because Claude Code's `-p` print mode is
expected to start costing Anthropic API credits, whereas Codex titling rides existing
ChatGPT/OpenAI auth at no marginal cost. Titling is a high-volume background job (one call
per Session, 163+ on first backfill), so marginal cost matters.

Titling runs hermetically and non-agentically: `codex exec --ephemeral --skip-git-repo-check
--sandbox read-only --ignore-rules --ignore-user-config`, with `--output-schema` forcing a
`{"title": "..."}` response and `--output-last-message` capturing it cleanly. The bounded
session skeleton (first ~6 / last ~2 text turns, tool I/O stubbed) is piped via stdin.

The titler sits behind a single interface, so swapping back to `claude -p`, an SDK, or a
local model is a one-file change if the cost calculus flips.
