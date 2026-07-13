# A role declares its birth setup in a `spawn` hook

Decided with Milad 2026-07-12. Generalizes the `spawn-location` hook (ADR-0046) — which already
declares WHERE a role launches — into a full `spawn` hook that declares the SETUP a role's session
needs at birth. The last big lump of imperative, cluster-specific spawn logic (`spawn-agent.sh`'s
`grant_worktree_perms`) becomes declarative config, resolved through the same layered pipeline as
`start`/`stop`. Instance of ADR-0061 (generic mechanism / cluster vocabulary), applied to spawn.

## The problem

`ccs new-session` mints a session's identity + row, then either launches or reserves it. But a
worker often needs FILESYSTEM setup to run correctly headless: permission allow-rules (so it doesn't
stall on prompts), a statusLine wiring, pre-seeded state files. Today that lives in a bespoke
per-cluster shell script (pr-watch's `spawn-agent.sh` `grant_worktree_perms` — a ~40-line jq blob).
That is cluster policy encoded imperatively, un-inspectable, and unavailable to any other cluster:
a second cluster's worker can't get born-correct without writing its own spawn script.

The tool already has the mechanism for this everywhere else — a hook type, resolved per identity
LEVEL, fired at a lifecycle moment (ADR-0043/0044). Spawn setup is just another such moment.

## Decision

**A role declares its birth setup as an ordered list of `spawn` actions in `.ccs-hooks/spawn.json`.
`ccs new-session` runs them (in the launch cwd) at birth, for both `--print-id` (reserve) and direct
launch.** It fires at `new-session`, `rowResolved: true` (the row exists), merge `ordered-actions` —
the same shape as `start`.

Two built-in actions generalize what the pr-watch script did by hand:
- **grant-perms**: merge an authored `allow` list (+ optional `statusLine`) into the launch cwd's
  `.claude/settings.local.json` (never clobbering existing rules). `{cwd}`/`{home}` placeholders
  expand. This is the deterministic replacement for `grant_worktree_perms`.
- **seed-files**: pre-create listed files with `{}` if absent (so the first write is an EDIT, not a
  create-prompt under acceptEdits). Paths relative to cwd; `{home}` expands for out-of-cwd files.

Deterministic + fail-open: a throwing/unknown action is recorded and skipped; a spawn is never
blocked by a best-effort setup step. `ccs hooks lint` flags a `spawn` action with no handler (same
as `start`).

## What stays in the cluster script (the honest boundary)

Not everything moves. `ccs new-session` deliberately does NOT launch cmux (ADR-0042/M3: it mints,
the launcher spawns), so `spawn-agent.sh` still owns the `cmux new-workspace` call, the registry
bookkeeping (`sessions.json`), and the reuse-if-warm check. And pr-watch's per-PR state files
(`pr-<key>.judgment.json`, keyed by a dispatch arg the tool doesn't know) stay in `precreate_state`.
The `spawn` hook takes the GENERAL born-correct setup (perms + statusLine); the launch + key-specific
bits remain engine. This is the same mechanism-vs-policy line as the other evictions.

## Consequences

- **New hook type `spawn`** (`firesOn: new-session`, `ordered-actions`, `rowResolved`) + a runner
  (`spawn-actions.ts`, mirrors `start-actions`) with built-ins grant-perms + seed-files.
- **`ccs new-session`** runs the resolved spawn actions right after writing the row, in the launch
  cwd — so the launcher (spawn-agent or the direct path) starts claude on an already-prepared cwd.
- **pr-watch**: pr-agent gains `.ccs-hooks/spawn.json` (grant-perms with the worktree/state allow
  rules + `ccs statusline`); `spawn-agent.sh` drops `grant_worktree_perms`. `precreate_state` stays.
- **A second cluster gets born-correct workers for free**: declare a `spawn.json`, no spawn script.
- **Glossary/units**: add **spawn hook** (role-declared birth setup) alongside spawn-location.
- **Extends, doesn't replace, spawn-location**: location resolves pre-row (which cwd); `spawn` runs
  post-row (setup IN that cwd). Two hooks, two moments, one new-session flow.
