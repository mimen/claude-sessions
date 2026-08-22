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

## Build & run

```sh
cd macos/CcsUsageMenuBar
swift test          # unit tests for parsing + gauge logic
./make-app.sh       # build CcsUsage.app
./make-app.sh --install   # install to /Applications and launch
```

The app is LSUIElement (no Dock icon). Quit from the power button in the panel footer.
