---
deployment_status: verified
deployment_production_trigger: merge to master
deployment_verify_command: ccs doctor launcher && ccs doctor models
deployment_last_assessed: 2026-09-03
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

`bun run setup` updates the Bun link for `ccs`. `ccs launcher install` writes the shim, named wrappers, launcher environments, per-launcher Claude Code settings, the opencode model map, and T3 Code's model list from the current shared configuration.

## Verify production

Run the checked deployment tests:

```sh
ccs doctor launcher && ccs doctor models
```

Both commands must exit 0. `ccs doctor launcher` compares installed files and the deployment checkout with their sources. `ccs doctor models` checks every model id consumed by Claude Code, CCS routing, Hermes, and pstack against `models.toml`, refuses a picker mapping that would misaccount a context window, and cross-checks the live gateway catalogue. It reaches the network: an unreachable gateway is a warning, not a failure.

## Recover

Revert the bad commit on `master`. Then repeat the production deployment and verification commands. Do not edit generated files under `/Users/mimen/.ccs/` by hand.
