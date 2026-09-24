# CcsUsageMenuBar

A native macOS menu bar app that shows live provider usage from `ccs usage --json`:
allowance gauges per provider/window (Claude, Codex, Grok, OpenCode Go), credit balances,
and the tightest gauge as the menu bar label.

Pure SwiftUI (`MenuBarExtra`), no dependencies, macOS 13+. The app shells out to `ccs`
(resolved from `~/.bun/bin/ccs`, Homebrew, or PATH) every 5 minutes, on open, and on ⌘R.

## What it shows

- **Menu bar**: a gauge icon plus the highest used-percentage across all gauges, tinted
  green < 60%, orange < 85%, red at 85%+.
- **Panel**: gauges grouped by provider with reset countdowns; credit balances shown in
  dollars; Venice per-model minute rate limits are dropped as noise; Grok `#build` /
  `#chat` / `#imagine` sub-pools collapse into their parent row when one exists.

### Order and freshness

Drag a section header to reorder sections, or drag a row to reorder it within its section. Both orders persist in the app's defaults (`sectionOrder`, `rowOrder`), and anything new appends in its natural position.

Accounts are labelled by their email. There is no alias table; a plan badge comes from the configured subscription, or from Claude's reported tier when none is configured.

`CcsUsage --render out.png` writes a PNG of the panel from a live fetch, for checking layout without opening the menu bar.

A failed refresh never blanks the panel. When ccs reports a provider unavailable, that provider's previous rows stay on screen with a stale badge aged from their real fetch time. The footer shows how old the data is, and reads `outdated` after two missed polls.

### Claude Fable row

Each Claude account shows its raw weekly Fable cap beside the all-models weekly pool. The Fable cap nests inside that pool, so it never drives the menu bar reading.

## Build & run

```sh
cd macos/CcsUsageMenuBar
swift test          # unit tests for parsing + gauge logic
./make-app.sh       # build CcsUsage.app
./make-app.sh --install   # install to /Applications and launch
```

The app is LSUIElement (no Dock icon). `--install` also writes and loads the
`com.milad.ccs.usage-menubar` LaunchAgent, which starts the app at login and restarts it
after a crash. The power button in the panel footer quits the process; launchd brings it
back within 15 seconds. To stop it for real:

```sh
launchctl bootout gui/$(id -u)/com.milad.ccs.usage-menubar
```

Refresh activity logs to `~/.ccs-usage-menubar.log` (local time, capped at 2 MB); the
process's own stdout and stderr land in `~/Library/Logs/com.milad.ccs.usage-menubar.log`.
