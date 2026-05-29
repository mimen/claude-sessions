# Use the Codex CLI (OpenAI) to generate Session titles (gap-fill only)

**Amended 2026-05-29 during Milestone 2:** Claude Code 2.1.156 already writes native
`ai-title` lines into Session files (~59/172 Sessions on this Host). Native titles are
therefore the *primary* source and cost nothing. Title resolution is:
`native ai-title → Codex-generated → cleaned-first-message`. Codex only fills the gap for
Sessions that have no native title, which cuts generation by roughly two-thirds and keeps
shrinking as Claude Code titles more Sessions. The rest of this decision stands for that
gap-fill case.

This is a tool for Claude Code sessions, so the obvious gap-fill titler is `claude -p`. We
deliberately use the `codex exec` CLI instead, because Claude Code's `-p` print mode is
expected to start costing Anthropic API credits, whereas Codex titling rides existing
ChatGPT/OpenAI auth at no marginal cost. Even gap-fill titling is a background batch, so
marginal cost matters.

Titling runs hermetically and non-agentically: `codex exec --ephemeral --skip-git-repo-check
--sandbox read-only --ignore-rules --ignore-user-config`, with `--output-schema` forcing a
`{"title": "..."}` response and `--output-last-message` capturing it cleanly. The bounded
session skeleton (first ~6 / last ~2 text turns, tool I/O stubbed) is piped via stdin.

The titler sits behind a single interface, so swapping back to `claude -p`, an SDK, or a
local model is a one-file change if the cost calculus flips.
