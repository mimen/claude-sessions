#!/usr/bin/env bash
# Screenshot the live cmux window (which hosts the sidebar extension) into an evidence file.
#
# Usage: shot.sh <out.png> [app]     app defaults to cmux; use "cmux CCS" for the staging fork.
#
# Read the PNG afterwards. The sidebar has no accessibility tree — a screenshot is the only way to
# see the real panel, and coordinates for peekaboo click come from looking at this image.
set -euo pipefail

OUT="${1:?usage: shot.sh <out.png> [app]}"
APP="${2:-cmux}"
mkdir -p "$(dirname "$OUT")"

if ! peekaboo permissions 2>/dev/null | grep -q 'Screen Recording (Required): Granted'; then
  cat >&2 <<'EOF'
Screen Recording is not granted to the peekaboo bridge host, so no screenshot is possible.

Grant it: System Settings > Privacy & Security > Screen & System Audio Recording > "+" >
Cmd-Shift-G > /opt/homebrew/bin/peekaboo. The "+" requires Touch ID, so a human has to be there;
an agent cannot complete this step alone. Afterwards: peekaboo daemon restart.

Until then use macos/.build/release/ccs-sidebar-render for visual proof — it needs no permission.
EOF
  exit 3
fi

peekaboo image --app "$APP" --path "$OUT" >/dev/null
printf 'wrote %s\n' "$OUT"
