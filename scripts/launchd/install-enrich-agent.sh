#!/usr/bin/env bash
# Install (or reinstall) the session-enrichment sweep as a user LaunchAgent.
#
# Idempotent: boots the job out first if it is already loaded, so re-running after editing the
# plist actually picks up the change instead of silently keeping the old definition.
set -euo pipefail

LABEL="com.milad.ccs.enrich"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${LABEL}.plist"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
BUN_BIN="/opt/homebrew/bin/bun"
# Read the checkout straight out of the plist so the two can never disagree about which ccs runs.
CCS_BIN="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$SRC")"

# Fail before installing rather than after, so a broken job never gets scheduled.
[[ -x "$BUN_BIN" ]] || { echo "missing bun at $BUN_BIN" >&2; exit 1; }
[[ -f "$CCS_BIN" ]] || { echo "missing ccs at $CCS_BIN" >&2; exit 1; }
# The deployed ccs predates `enrich`; installing an agent that fails every 15 minutes is worse
# than not installing one, so prove the command exists in THIS checkout before scheduling it.
"$BUN_BIN" "$CCS_BIN" enrich --list --limit 1 >/dev/null 2>&1 \
  || { echo "ccs at $CCS_BIN does not support 'enrich' — repoint the plist" >&2; exit 1; }
[[ -f "${HOME}/.cli-proxy-api-key" ]] || { echo "missing gateway key at ~/.cli-proxy-api-key" >&2; exit 1; }

mkdir -p "${HOME}/Library/LaunchAgents"
cp "$SRC" "$DEST"

if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/${LABEL}"
fi
launchctl bootstrap "gui/$(id -u)" "$DEST"

echo "installed ${LABEL} (every 900s, --limit 40)"
echo "logs: ${HOME}/Library/Logs/${LABEL}.log"
echo "run now: launchctl kickstart -k gui/$(id -u)/${LABEL}"
