# CCS native sidebar

A cmux sidebar extension that renders the CCS session list in SwiftUI, alongside the web sidebar
rather than in place of it.

It is a client of the sidebar server, not a second implementation. Rows come from
`http://127.0.0.1:8788/api/snapshot`, which already projects, orders and enriches them, so the
catalogue, index, cmux bridge and every action stay in one place with the tests that hold them.
That also keeps the sandbox simple: the extension needs `com.apple.security.network.client` and
nothing else.

## Layout

    Package.swift                       SwiftPM view of the shared sources, plus the renderer
    Sources/ccs-sidebar-render/         Headless PNG renderer, the visual feedback loop
    CcsSidebarApp/                      Host app + ExtensionKit appex (from cmux's sample)
      SampleSidebarExtension/Shared/    The views — compiled by BOTH SwiftPM and Xcode
      SampleSidebarExtension/Extension/ The appex entry point and manifest

`Shared/` has one copy of the views on purpose. SwiftPM points at that folder rather than owning
its own, so a rendered image cannot drift from what the extension ships.

## Seeing a change without launching anything

    swift build -c release && ./.build/release/ccs-sidebar-render /tmp/sidebar.png 14

Writes a PNG straight from the view tree — no window, no app, no screen-recording permission.
`ScrollView` and `LazyVStack` rasterise blank under `ImageRenderer`, so the renderer draws a plain
stack; scrolling and menus are checked against the installed extension instead.

## Building and installing the extension

    ln -sfn <cmux-checkout>/Packages/macOS/CmuxExtensionKit macos/CmuxExtensionKit
    cd CcsSidebarApp
    xcodebuild -project SampleSidebarExtensionApp.xcodeproj -scheme SampleSidebarExtensionApp \
      -configuration Debug -derivedDataPath /tmp/ccs-ext-dd \
      CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<team> -allowProvisioningUpdates build
    cp -R "/tmp/ccs-ext-dd/Build/Products/Debug/CCS Sessions.app" ~/Applications/
    open "$HOME/Applications/CCS Sessions.app"

The SDK is symlinked per machine because it lives in the cmux checkout, not here. The host app must
stay installed: an appex is only available while its container app is.

Then in cmux: puzzle button beside the sidebar help button, Sidebar Extensions, enable CCS
Sessions, and choose the extension sidebar provider. The puzzle button appears only while
`extensions.beta.enabled` is set.
