#!/usr/bin/env bash
# Install (or reinstall) the catalogue refresh as a user LaunchAgent.
#
# Idempotent: boots the job out first if it is already loaded, so re-running after editing the
# plist actually picks up the change instead of silently keeping the old definition.
set -euo pipefail

LABEL="com.milad.ccs.catalogue-refresh"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${LABEL}.plist"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
BUN_BIN="/opt/homebrew/bin/bun"
# Read the deployment straight out of the plist so the installer and scheduled job cannot drift.
CCS_BIN="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$SRC")"

# Fail before installing rather than after, so a broken job never gets scheduled.
/usr/bin/plutil -lint "$SRC" >/dev/null
[[ -x "$BUN_BIN" ]] || { echo "missing bun at $BUN_BIN" >&2; exit 1; }
[[ -f "$CCS_BIN" ]] || { echo "missing ccs at $CCS_BIN" >&2; exit 1; }
CCS_HELP="$("$BUN_BIN" "$CCS_BIN" --help)"
[[ "$CCS_HELP" == *"ccs reindex"* ]] \
  || { echo "ccs at $CCS_BIN does not support 'reindex' — repoint the plist" >&2; exit 1; }

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
cp "$SRC" "$DEST"

if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/${LABEL}"
fi
launchctl bootstrap "gui/$(id -u)" "$DEST"

# StartInterval is intentional rather than KeepAlive: the on-demand catalogue daemon idles after
# 30 seconds, and keeping it resident would defeat that lifecycle instead of periodically healing.
echo "installed ${LABEL} (RunAtLoad, every 300s)"
echo "logs: ${HOME}/Library/Logs/${LABEL}.log"
echo "run now: launchctl kickstart -k gui/$(id -u)/${LABEL}"
