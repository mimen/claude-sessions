#!/usr/bin/env bash
# Build, install and reconnect the CCS sidebar extension.
#
# The naive loop — kill the app, delete the bundle, copy a new one — leaves cmux holding a handle
# to an extension that no longer exists on disk, which shows as "Extension Blocked" and cannot be
# recovered with Try Again. Replacing the bundle in place and then making cmux re-pick the provider
# avoids both halves of that.
set -euo pipefail

TEAM="${CCS_SIGNING_TEAM:-458KZD965T}"
# Every cmux build that might be hosting the extension. A reload that touches only one leaves the
# others running the previous build while reporting success, which is worse than not reloading.
DOMAINS=(${CCS_CMUX_DOMAINS:-com.cmuxterm.app com.cmuxterm.app.staging.ccs})
APP_NAME="CCS Sessions.app"
DERIVED="${TMPDIR:-/tmp}/ccs-ext-dd"
INSTALLED="$HOME/Applications/$APP_NAME"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "building…"
xcodebuild -project "$ROOT/CcsSidebarApp/SampleSidebarExtensionApp.xcodeproj" \
  -scheme SampleSidebarExtensionApp -configuration Debug \
  -derivedDataPath "$DERIVED" \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM" -allowProvisioningUpdates \
  build > "$DERIVED.log" 2>&1 || { grep -E "error:" "$DERIVED.log" | head -5; exit 1; }

BUILT="$DERIVED/Build/Products/Debug/$APP_NAME"
[[ -d "$BUILT" ]] || { echo "no app at $BUILT" >&2; exit 1; }

# Quit the host, then overwrite in place. `ditto` replaces contents without unlinking the bundle
# directory itself, so anything holding the path keeps resolving it.
pkill -f "$APP_NAME/Contents/MacOS" 2>/dev/null || true
# And the extension process itself. Bouncing the provider rebuilds cmux's host but reuses a running
# appex, so a new build can be installed, registered and reported successfully while every window
# keeps executing the previous one — which is indistinguishable from a fix that did not work.
pkill -f "CCS Sessions Extension.appex" 2>/dev/null || true
mkdir -p "$HOME/Applications"
ditto "$BUILT" "$INSTALLED"
open "$INSTALLED"

# Wait for the appex to re-register before touching cmux, or the provider switch lands on nothing.
for _ in $(seq 1 30); do
  pluginkit -m -p com.cmuxterm.app.cmux.sidebar 2>/dev/null | grep -q "ccs.sidebar" && break
  sleep 0.5
done

# Make each cmux showing the extension drop its stale host and build a new one: leave the provider
# and come back to it.
for domain in "${DOMAINS[@]}"; do
  current=$(defaults read "$domain" cmuxExtensionSidebar.providerId 2>/dev/null || echo "")
  [[ "$current" == "cmux.sidebar.extensions" ]] || continue
  defaults write "$domain" cmuxExtensionSidebar.providerId -string "cmux.sidebar.default"
  sleep 1
  defaults write "$domain" cmuxExtensionSidebar.providerId -string "cmux.sidebar.extensions"
  echo "reloaded $domain"
done

echo "installed: $(pluginkit -m -p com.cmuxterm.app.cmux.sidebar 2>/dev/null | tr -d ' ')"
