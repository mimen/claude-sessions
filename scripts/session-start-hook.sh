#!/usr/bin/env bash
# ccs SessionStart hook (ADR-0017/0035) — registration + arming safety net.
#
# Claude Code invokes this on every session start and pipes a JSON payload on stdin
# (session_id, source, cwd, …). We hand it straight to `ccs register-session`, which
# registers/refreshes the session and prints any additionalContext (ask-to-register /
# re-arm) to stdout — Claude Code feeds that to the agent as context.
#
# FAIL-OPEN (ADR-0035): this must NEVER block session start. `ccs register-session`
# already exits 0 on any error; the extra guards here (timeout, `|| true`) ensure even a
# missing/wedged ccs binary can't wedge the session — worst case is no registration this
# start, retried on the next hook fire.
#
# NOT INSTALLED AUTOMATICALLY. To wire it in, add to ~/.claude/settings.json:
#   { "hooks": { "SessionStart": [ { "hooks": [
#       { "type": "command", "command": "~/projects/claude-sessions/scripts/session-start-hook.sh" }
#   ] } ] } }
# (or run scripts/install-session-start-hook.sh, which writes it inside a managed block).

CCS="$(command -v ccs || echo "$HOME/.bun/bin/ccs")"

# ~2s budget so a wedged ccs can't hang startup (ADR-0035). `timeout` may be absent on
# macOS; fall back to running without it. Always succeed.
if command -v timeout >/dev/null 2>&1; then
  timeout 3 "$CCS" register-session 2>/dev/null || true
else
  "$CCS" register-session 2>/dev/null || true
fi
exit 0
