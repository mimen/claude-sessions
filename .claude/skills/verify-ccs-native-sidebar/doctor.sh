#!/usr/bin/env bash
# Read-only health read for the CCS native sidebar. Answers "is this instance worth driving?"
# and, above all, "which SHA is the installed extension actually executing?" — the answer to most
# "the sidebar is wrong" reports.
#
# Usage: doctor.sh [port]   (default 8787; pass your own port when running your own serve)
set -uo pipefail

PORT="${1:-8787}"
APPEX="$HOME/Applications/CCS Sessions.app/Contents/Extensions/CCS Sessions Extension.appex"
LOG="$HOME/Library/Containers/com.milad.ccs.sidebar.Extension/Data/Library/Caches/ccs-sidebar.log"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && git rev-parse --show-toplevel 2>/dev/null)"

say() { printf '%-22s %s\n' "$1" "$2"; }

snapshot="$(curl -s -m 5 "http://127.0.0.1:${PORT}/api/snapshot?limit=1" 2>/dev/null)"
if [[ -z "$snapshot" ]]; then
  say "server:${PORT}" "DOWN — nothing answering. Rows, actions and the renderer all fail from here."
  SERVER_SHA=""
else
  read -r SERVER_SHA rev live idx cat rows <<<"$(printf '%s' "$snapshot" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(d.get("serverVersion","?"), d.get("snapshotRevision","?"),
      d.get("livenessReadable"), d.get("indexReadable"), d.get("catalogueReadable"),
      len(d.get("rows",[])))')"
  say "server:${PORT}" "up — version ${SERVER_SHA}, revision ${rev}, ${rows} row(s) returned"
  say "stores readable" "liveness=${live} index=${idx} catalogue=${cat}"
  err="$(printf '%s' "$snapshot" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("categoryProjectionError") or "")')"
  [[ -n "$err" ]] && say "category registry" "ERROR — ${err}"
fi

if [[ -d "$APPEX" ]]; then
  stamp="$(strings "$APPEX/Contents/MacOS/"* 2>/dev/null | grep -m1 -E '^[0-9a-f]{7,}\+?$')"
  built="$(strings "$APPEX/Contents/MacOS/"* 2>/dev/null | grep -m1 -E '^20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$')"
  say "appex build" "${stamp:-unstamped} (built ${built:-unknown})"
  if [[ -n "$ROOT" && -n "$stamp" ]]; then
    head="$(git -C "$ROOT" rev-parse --short HEAD)"
    if [[ "${stamp%+}" == "$head" ]]; then
      say "vs checkout" "matches HEAD ${head}"
    else
      say "vs checkout" "DIFFERS — HEAD is ${head}, installed is ${stamp}. Run macos/install.sh before believing the panel."
    fi
  fi
  [[ -n "$SERVER_SHA" && -n "$stamp" && "${stamp%+}" != "$SERVER_SHA" ]] &&
    say "vs server" "client ${stamp} / server ${SERVER_SHA} — the two halves are different builds"
else
  say "appex build" "NOT INSTALLED at ${APPEX}"
fi

reg="$(pluginkit -m -p com.cmuxterm.app.cmux.sidebar 2>/dev/null | tr -s ' ')"
say "registration" "${reg:-none — cmux cannot see the extension}"

if [[ -f "$LOG" ]]; then
  say "last diagnostic" "$(tail -n 1 "$LOG")"
  say "last connect" "$(grep -E 'connected to port' "$LOG" | tail -n 1)"
else
  say "diagnostics log" "absent — the extension has never run in this container"
fi

for domain in com.cmuxterm.app com.cmuxterm.app.staging.ccs; do
  provider="$(defaults read "$domain" cmuxExtensionSidebar.providerId 2>/dev/null)"
  [[ -n "$provider" ]] && say "provider:${domain##*.}" "$provider"
done

if command -v peekaboo >/dev/null; then
  peekaboo permissions 2>/dev/null | grep -E '^(Screen Recording|Accessibility)' | while read -r line; do
    say "peekaboo" "$line"
  done
else
  say "peekaboo" "not installed — the live panel cannot be screenshotted or clicked"
fi
