#!/usr/bin/env bash
# Build, install and reconnect the CCS sidebar extension.
#
# The naive loop — kill the app, delete the bundle, copy a new one — leaves cmux holding a handle
# to an extension that no longer exists on disk, which shows as "Extension Blocked" and cannot be
# recovered with Try Again. Replacing the bundle in place and then making cmux re-pick the provider
# avoids both halves of that.
set -euo pipefail

TEAM="${CCS_SIGNING_TEAM:-458KZD965T}"
DOMAIN="${CCS_CMUX_DOMAIN:-com.cmuxterm.app.staging.ccs}"
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
mkdir -p "$HOME/Applications"
ditto "$BUILT" "$INSTALLED"
open "$INSTALLED"

# Wait for the appex to re-register before touching cmux, or the provider switch lands on nothing.
for _ in $(seq 1 30); do
  pluginkit -m -p com.cmuxterm.app.cmux.sidebar 2>/dev/null | grep -q "ccs.sidebar" && break
  sleep 0.5
done

# Make cmux drop the stale host and build a new one: leave the provider and come back to it.
CURRENT=$(defaults read "$DOMAIN" cmuxExtensionSidebar.providerId 2>/dev/null || echo "cmux.sidebar.default")
if [[ "$CURRENT" == "cmux.sidebar.extensions" ]]; then
  defaults write "$DOMAIN" cmuxExtensionSidebar.providerId -string "cmux.sidebar.default"
  sleep 1
  defaults write "$DOMAIN" cmuxExtensionSidebar.providerId -string "cmux.sidebar.extensions"
fi

echo "installed: $(pluginkit -m -p com.cmuxterm.app.cmux.sidebar 2>/dev/null | tr -d ' ')"
