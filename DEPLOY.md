---
deployment_status: deterministic
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
| Generated launcher environments | `/Users/mimen/.ccs/launcher-env/*` |

The shared configuration lives in `/Users/mimen/Documents/milad-vault/ClaudeConfig/session-routing/`. Secret values stay in referenced files and never enter this repository or the shared registry.

## Deploy production

After `master` advances, update the deployment checkout and regenerate every installed file:

```sh
git -C /Users/mimen/Programming/Deployments/claude-sessions pull --ff-only
bun install --cwd /Users/mimen/Programming/Deployments/claude-sessions --frozen-lockfile
cd /Users/mimen/Programming/Deployments/claude-sessions && bun run setup
ccs launcher install
```

`bun run setup` updates the Bun link for `ccs`. `ccs launcher install` writes the shim, named wrappers, and launcher environments from the current shared configuration.

## Verify production

Run the checked deployment tests:

```sh
ccs doctor launcher && ccs doctor models
```

Both commands must exit 0. `ccs doctor launcher` compares installed files and the deployment checkout with their sources. `ccs doctor models` checks the model IDs consumed by Claude Code and the canonical model IDs stored in CCS routing.

## Recover

Revert the bad commit on `master`. Then repeat the production deployment and verification commands. Do not edit generated files under `/Users/mimen/.ccs/` by hand.
