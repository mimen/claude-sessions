---
name: verify-ccs-native-sidebar
description: Drive the CCS native cmux sidebar — the SwiftUI ExtensionKit appex in macos/CcsSidebarApp — and capture evidence that a change works. Use after touching macos/ or src/sidebar, or whenever a claim about the sidebar needs proof: headless view rendering, package tests, the installed extension's own diagnostics, the server snapshot it reads, and the live panel inside cmux.
---

# Verify the CCS native sidebar

The surface is a macOS sidebar extension (`.appex`) that cmux hosts in its own window. It is a
**client of the sidebar server**, not a second implementation: rows come from
`GET http://127.0.0.1:8787/api/snapshot`, and every mutation is a POST to that same server. So a
change is usually in one of two places, and they are proved differently:

| Change lives in | Prove it with |
| --- | --- |
| `src/sidebar/**` (projection, caches, actions) | the server: `curl /api/snapshot`, `bun test`, plus a native re-read |
| `macos/**` (views, client, menus) | the headless renderer + `swift test`, then the installed extension |

Read [`docs/sidebar-concepts.md`](../../../docs/sidebar-concepts.md) before debugging anything
that "looks wrong" — it splits the sidebar into five layers and gives a probe per layer. This
skill is how you drive them; that document is how you decide which one to drive.

## Launch

There is no app to start. Three things must be true, and none of them is "run the sidebar".

**1. The server is up.** A LaunchAgent already serves port 8787 from an exported release
(`~/.local/share/ccs/sidebar-releases/<sha>/bin/ccs sidebar serve --port 8787`, label
`com.milad.ccs.sidebar`). It is the user's live queue — never restart or kill it. To exercise
*your worktree's* server code, start your own on a spare port instead:

```sh
bun install --frozen-lockfile                 # a fresh worktree has no node_modules
bun run bin/ccs sidebar serve --port 8799     # yours; teardown is your job
curl -s http://127.0.0.1:8799/api/snapshot?limit=1 >/dev/null && echo up
```

A server run from a worktree reports `serverVersion: "dev"` rather than a SHA — that is how
`doctor.sh` tells your instance from the packaged release.

**2. The Swift package builds.** From `macos/`:

```sh
swift build -c release      # ~16s cold, seconds warm
swift test                  # 27 tests today, all in Tests/CcsSidebarUITests
```

`swift build` needs nothing outside the repo. Building the *extension* does: `install.sh`
symlinks the SDK out of a cmux checkout, and it is per machine, so a fresh worktree has no
`macos/CmuxExtensionKit` until you create one.

**3. The extension is installed** (only when the proof needs the real panel):

```sh
ln -sfn <cmux-checkout>/Packages/macOS/CmuxExtensionKit macos/CmuxExtensionKit
macos/install.sh            # xcodebuild → ~/Applications/CCS Sessions.app, then bounces the provider
```

`install.sh` stamps `BuildStamp.swift` with the git SHA, builds, replaces the bundle in place with
`ditto`, waits for the appex to re-register, and makes cmux drop its stale host. Read its comments
before improvising: deleting the installed bundle while cmux holds it produces "Extension Blocked",
which Try Again cannot recover.

**Teardown** is only ever for what you started: your own `ccs sidebar serve` on your own port. See
Cleanup.

## Doctor

One read-only command answers "is this instance worth driving?":

```sh
.claude/skills/verify-ccs-native-sidebar/doctor.sh          # defaults to port 8787
.claude/skills/verify-ccs-native-sidebar/doctor.sh 8799     # your own server
```

It prints one line per fact: server reachable and its `serverVersion`, whether the stores are
readable, the appex's registration, the SHA the *installed* extension is executing, whether that
matches `git HEAD`, when the extension last connected to the server, cmux's chosen sidebar
provider, and which peekaboo permissions exist. Run it first whenever anything looks off — most
"the sidebar is wrong" reports are the installed appex executing an older SHA than the checkout.

## Drive

Four harnesses, cheapest first. Use the cheapest one that can actually see the thing you changed.

### 1. Headless render — the shipped views, as pixels

```sh
cd macos && swift build -c release
./.build/release/ccs-sidebar-render /tmp/ccs-sidebar.png 14 active 8787
#                                   <out>              <rows> <scope> <port>
```

`Sources/ccs-sidebar-render` draws `SessionRowView` — the same file the appex ships, via one
`Shared/` folder compiled by both SwiftPM and Xcode — against live server data, each row twice:
at rest and hovered. No window, no screen-recording permission. Then **read the PNG**; a render
that was never looked at proves nothing.

Its one limit, stated in the source: `ScrollView` and `LazyVStack` rasterise blank under
`ImageRenderer`, so it draws a plain stack. Scrolling, popovers, context menus and hover tracking
are not visible here — those go to harness 4.

### 2. Package tests — the logic under the views

```sh
cd macos && swift test
```

Covers `SnapshotClient` request/refresh discipline, `ClusterSplit`, `RowVisibility`, change frames.
Add a case here when the bug is about *which* rows or *which* request, not about paint.

### 3. The server the extension reads — state and side effects

```sh
curl -s 'http://127.0.0.1:8787/api/snapshot?limit=2000&scope=active&include=saved' | python3 -m json.tool | less
```

Top level carries `serverVersion`, `snapshotRevision`, `lifecycleCounts`, `t3Count`,
`hasMoreRows`, and the `livenessReadable` / `indexReadable` / `catalogueReadable` flags the panel
turns into notices. Never truncate ids quoted from here: live sessions share long prefixes.

The action endpoints are what the native `ActionClient` posts to, one per row command:
`/api/open`, `/api/session/lifecycle`, `/api/session/decline`, `/api/session/incognito`,
`/api/session/close`, `/api/session/destroy` (+ `/destroy/preflight`), `/api/workspace/focus`,
`/api/workspace/pin`, `/api/workspace/close`. Every POST needs an `Origin` header
matching the bound address (`-H 'Origin: http://127.0.0.1:8787'`) or the server answers 403
`{"code":"denied"}`. Curling one proves the server half of a feature, not the sidebar: it says
nothing about whether the row, the menu item, or the confirmation exists.
Verify the side effect after any action you do drive — `sqlite3 ~/.ccs/cache/catalogue.db` for
lifecycle, `cmux tree --all --json` for focus and tabs.

**`/api/session/destroy` erases a session and its descendants from disk and nothing undoes it.**
Never call it to "test the endpoint". Drive destroy only against a session you created for the
purpose, and check its preflight response names exactly the descendants you expect.

### 4. The live panel in cmux — the only harness that sees the real thing

Two facts about this machine shape everything below:

- cmux's accessibility tree exposes **nothing** inside the sidebar (`peekaboo inspect-ui --app cmux`
  returns a single element). There are no row identifiers to click by name. Clicks are global
  coordinates read off a screenshot.
- Screenshots need Screen Recording, and macOS attributes it to the **responsible process** — the
  app the agent's shell runs under, not the `peekaboo` binary. Walk `ps -o ppid=` up from `$$` to
  find it (a Claude Code session under `T3 Code (Nightly)` is granted by that app's toggle, not by
  cmux's). Granting it — the "+" button or any existing toggle in System Settings > Privacy &
  Security > Screen & System Audio Recording — raises an admin password / Touch ID sheet, so an
  agent cannot do it alone: ask the user, and say which app needs the toggle.
  `peekaboo permissions` reports the state. Accessibility and event synthesis are already granted,
  so clicking and typing work regardless of this.

```sh
.claude/skills/verify-ccs-native-sidebar/shot.sh docs/evidence/native-sidebar/<stamp>/panel.png
peekaboo click --coords <x>,<y> --global-coords --foreground     # a row, read off that PNG
peekaboo click --coords <x>,<y> --global-coords --right          # its context menu
```

Take a shot, read it, decide coordinates, click, shoot again. Capture the action *and* the
resulting state — a single final screenshot cannot distinguish "the click worked" from "it was
already like that".

This is the user's live cmux: a click here really focuses a workspace and a menu item really
mutates a session. Prefer a row you created. If a proof would need a destructive action on a real
session, do it on the isolated fork instead (below) or stop and ask.

### Isolation, and its limit

A second, fully isolated stack exists: port 8788 served against the staging cmux socket
(`/tmp/cmux-staging-ccs.sock`, app `cmux CCS.app`, defaults domain `com.cmuxterm.app.staging.ccs`),
installed by `scripts/launchd/install-sidebar-agent.sh fork <commit-ish>`. Use it when a proof
needs actions that would disturb real work.

**The appex itself does not isolate.** There is one bundle at `~/Applications/CCS Sessions.app`
and one registration; `install.sh` replaces the extension the user is currently looking at. Do not
install a build mid-session without saying so, and never install one that has not passed
`swift build` and `swift test` first.

## Evidence

Everything a proof produces goes under `docs/evidence/native-sidebar/<UTC-stamp>/`, alongside the
repo's existing evidence (`docs/evidence/`). A complete proof carries:

- the render or screenshot **plus** what you read in it, in words;
- `doctor.sh` output, which pins the SHA the extension was executing when the evidence was taken;
- the `curl` response or `sqlite3` row for any side effect the picture cannot show;
- for a live-panel proof: before *and* after, not just after.

Standards: drive the real user path (a click on a row, a menu item), not an internal setter or a
convenient endpoint that skips the view. Do not mock the server — it is a local process, and the
whole point of this design is that the native client has no logic the server does not own.

## Cleanup

```sh
kill <pid-of-your-own-serve>              # the one you started, by PID
```

Never `pkill -f "sidebar serve"` — that kills the user's resident 8787 agent. Never
`launchctl bootout` the LaunchAgent. Never delete `~/Applications/CCS Sessions.app` (that is the
"Extension Blocked" trap; `install.sh` replaces it in place instead).

`install.sh` restores the tracked `BuildStamp.swift` placeholder on exit, including on failure —
if `git status` shows it modified, restore it before committing.

Cleanup removes processes and scratch files only. Evidence under `docs/evidence/native-sidebar/`
survives; delete nothing there.

## Helpers

Both live beside this file and are executable:

- `doctor.sh [port]` — the read-only health read described above.
- `shot.sh <out.png> [app]` — screenshot the cmux window through peekaboo, failing with the exact
  permission instruction when Screen Recording is missing.

## Features

[`features/README.md`](features/README.md) indexes what a user can actually do in this panel, one
file per feature, each with how to reach it and what end state proves it. A proof that drives one
convenient entry point is incomplete while the map lists others.
