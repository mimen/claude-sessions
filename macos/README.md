# CCS native sidebar

A cmux sidebar extension that renders the CCS session list in SwiftUI. This is where sidebar work
happens now; the web sidebar in `src/sidebar/web` is frozen and kept as the fallback for a cmux
without the extensions beta, another machine, or a plain browser tab.

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
    ./install.sh

Use the script rather than copying by hand. Deleting the installed bundle while cmux is connected
to the extension inside it leaves cmux holding a handle to something that no longer exists — the
sidebar shows "Extension Blocked" and Try Again cannot recover it. The script overwrites the
bundle in place with `ditto`, waits for the appex to re-register, then makes cmux drop the stale
host by leaving the provider and returning to it.

The SDK is symlinked per machine because it lives in the cmux checkout, not here. The host app must
stay installed: an appex is only available while its container app is.

Then in cmux: puzzle button beside the sidebar help button, Sidebar Extensions, enable CCS
Sessions, and choose the extension sidebar provider. The puzzle button appears only while
`extensions.beta.enabled` is set.

## What it does

Everything the web sidebar does: open or resume on click, hover controls for save/done/close, a
context menu carrying the verdict and the lifecycle and session commands, destroy behind a
confirmation that names its descendants, summaries on hover, verdict chips, project icons, scope
and grouping and filter, three row layouts chosen separately for open and closed sessions,
clusters, shelvable sections, arrow-key navigation, and notices for unreadable liveness or a
truncated response.

Two things are natively better rather than merely equivalent. Menus and summary popovers are real
windows, so they extend past the sidebar's edge instead of being folded back inside it, and the
list is a `LazyVStack` in a real `ScrollView` rather than four hundred DOM rows re-rendered on a
one-second poll.
