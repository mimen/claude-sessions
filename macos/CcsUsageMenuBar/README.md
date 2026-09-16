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

### Claude account budgets

Each Claude account keeps its own section with a Fable budget row and a non-Fable budget row. One weekly pool covers every model, with a smaller Fable cap nested inside it. A Fable request spends both counters; a non-Fable request spends only the shared pool.

So the Fable budget is `max(Fable-used-percent, weekly-used-percent)` and the non-Fable budget is the weekly reading alone, matching the CLI. Each known row names the meter that bound it, and a row held down by the shared pool reads `limited by the weekly pool`. That tells you to switch accounts rather than to stop using Fable.

The Fable budget compares two readings, so a missing weekly reading, mismatched observation times, or mismatched reset windows leave it unknown. The non-Fable budget reads one meter and survives a missing Fable row. A stale reading is reported as `cached` on a known value, not withheld.

The raw Fable limit remains part of provider accounting but is hidden from the panel when its budget row is shown. Display budgets never change overall usage, plan weighting, raw JSON, or account routing.

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
