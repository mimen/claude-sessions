---
deployment_status: verified
deployment_production_trigger: merge to master
deployment_verify_command: ccs doctor launcher && ccs doctor models
deployment_last_assessed: 2026-09-03
deployment_targets:
  - component: ccs CLI and engine
    where: local-install
    detail: Bun-linked ccs and generated launcher files from the deployment checkout on M5, M3, and Mini
  - component: Go TUI
    where: local-install
    detail: Local Go terminal client launched by ccs
  - component: Productivity sidebar server
    where: m5-laptop
    detail: launchd com.milad.ccs.sidebar on 8787 and com.milad.ccs.sidebar-fork on 8788
  - component: Productivity sidebar server
    where: m3-laptop
    detail: launchd com.milad.ccs.sidebar on 8787
  - component: Sidebar web fallback
    where: m5-laptop
    detail: Bundled web client served by the local productivity sidebar server
  - component: Sidebar web fallback
    where: m3-laptop
    detail: Bundled web client served by the local productivity sidebar server
  - component: CCS native sidebar
    where: local-install
    detail: macos/install.sh builds ~/Applications/CCS Sessions.app; M3 receives the build from M5
  - component: Usage menu-bar app
    where: local-install
    detail: CcsUsage.app installed on M5, M3, and Mini; supervised by com.milad.ccs.usage-menubar
  - component: ccs plugin and marketplace
    where: local-install
    detail: Claude Code installs ccs@claude-sessions from the in-repo GitHub marketplace
  - component: Scheduled LaunchAgents
    where: mac-mini
    detail: launchd com.milad.ccs.catalogue-refresh
  - component: Scheduled LaunchAgents
    where: m5-laptop
    detail: launchd com.milad.ccs.catalogue-refresh and com.milad.ccs.enrich
  - component: Scheduled LaunchAgents
    where: m3-laptop
    detail: launchd com.milad.ccs.catalogue-refresh and com.milad.ccs.enrich
---

# Claude Sessions deployment

The repository ships a local CLI and the Claude Code launcher files that CCS generates from the shared launcher registry. It has no reachable URL.

## Shipped files

| Surface | Destination |
|---|---|
| Deployment checkout | `/Users/mimen/Programming/Deployments/claude-sessions` |
| `ccs` executable | `/Users/mimen/.bun/bin/ccs` |
| Default shim and named wrappers | `/Users/mimen/.ccs/bin/claude` and `/Users/mimen/.ccs/bin/*` |
| Generated launcher environments | `/Users/mimen/.ccs/launcher-env/*.env` |
| Generated per-launcher Claude Code settings | `/Users/mimen/.ccs/launcher-env/*.settings.json` |
| Generated opencode model map | `/Users/mimen/.config/opencode/opencode.jsonc`, key `provider.cliproxyapi.models` |
| Generated T3 Code model list | `/Users/mimen/.t3/userdata/settings.json` and `client-settings.json`, the `claudeAgent` keys |

The shared configuration lives in two places, both under `/Users/mimen/Documents/milad-vault/ClaudeConfig/`. Models are `models.toml` at the top level: the single source of every model id, family, context window, launcher membership, label, colour, price and birth eligibility, linked at `~/.ccs/models.toml`. The launcher fleet and the launch-location routes are `modes/infra/data/session-routing/`, linked at `~/.ccs/launchers.toml` and `~/.ccs/locations.toml`. Secret values stay in referenced files and never enter this repository or the shared registries.

Every generated surface above is rewritten from `models.toml`, and rewriting is idempotent: a second run changes nothing. The opencode and T3 rewrites replace one key each and preserve every other key verbatim; a machine without those files is skipped with a warning.

## Deploy production

After `master` advances, update the deployment checkout and regenerate every installed file:

```sh
git -C /Users/mimen/Programming/Deployments/claude-sessions pull --ff-only
bun install --cwd /Users/mimen/Programming/Deployments/claude-sessions --frozen-lockfile
cd /Users/mimen/Programming/Deployments/claude-sessions && bun run setup
ccs launcher install
```

`bun run setup` updates the Bun link for `ccs`, writes `~/.config/ccs/hub-read-token` and `~/.config/ccs/hub-ingest-token` (mode 0600) from `op://Sol/Hub Read/credential` and `op://Sol/Hub Ingest/credential`, and reports the checkout's commit to the hub with `POST /ingest/build`. Rerunning it rewrites nothing that already matches. A failed `op read` keeps existing token files. `ccs launcher install` writes the shim, named wrappers, launcher environments, per-launcher Claude Code settings, the opencode model map, and T3 Code's model list from the current shared configuration.

After a change under `macos/CcsUsageMenuBar` or `packages/usage-view`, rebuild and restart the menu bar from the deployment checkout:

```sh
cd /Users/mimen/Programming/Deployments/claude-sessions/macos/CcsUsageMenuBar && ./make-app.sh --install
```

The app embeds the checkout's commit and reports it to the hub at launch.

## Verify production

Run the checked deployment tests:

```sh
ccs doctor launcher && ccs doctor models
```

Both commands must exit 0. `ccs doctor launcher` compares installed files and the deployment checkout with their sources. `ccs doctor models` checks every model id consumed by Claude Code, CCS routing, Hermes, and pstack against `models.toml`, refuses a picker mapping that would misaccount a context window, and cross-checks the live gateway catalogue. It reaches the network: an unreachable gateway is a warning, not a failure.

## Recover

Revert the bad commit on `master`. Then repeat the production deployment and verification commands. Do not edit generated files under `/Users/mimen/.ccs/` by hand.
