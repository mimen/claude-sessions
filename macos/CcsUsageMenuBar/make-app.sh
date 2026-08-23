#!/bin/zsh -f
# Build CcsUsageMenuBar.app into macos/CcsUsageMenuBar/.build/ and install (optional).
# Usage: ./make-app.sh [--install]   (--install copies to /Applications and launches)

set -e
cd "$(dirname "$0")"

APP_NAME="CcsUsage"
APP_DIR=".build/${APP_NAME}.app"
CONTENTS="$APP_DIR/Contents"

swift build -c release

rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

cp .build/release/CcsUsageMenuBar "$CONTENTS/MacOS/$APP_NAME"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>com.auf.ccs-usage-menubar</string>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# Stable signature so Keychain ACLs (claude-swap token access) survive rebuilds —
# ad-hoc signatures change every build and re-trigger the permission prompt.
codesign --force --sign "Apple Development" "$APP_DIR" 2>/dev/null \
  || echo "warn: no signing identity found; keychain will re-prompt"

if [[ "$1" == "--install" ]]; then
  pkill -f "CcsUsage.app/Contents/MacOS/CcsUsage" 2>/dev/null || true
  rm -rf "/Applications/$APP_NAME.app"
  cp -R "$APP_DIR" /Applications/
  open "/Applications/$APP_NAME.app"
  echo "Installed and launched /Applications/$APP_NAME.app"
else
  echo "Built $PWD/$APP_DIR — run with --install to install to /Applications and launch."
fi
