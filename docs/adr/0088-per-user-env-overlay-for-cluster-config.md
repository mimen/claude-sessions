# ADR-0088: Per-user `.env` overlay for cluster config

**Status:** accepted (2026-07-14)

## Context

The shareability plan says teammates should be able to clone `~/.ccs-config` (or the pr-watch
cluster inside it) and run pr-watch on their own laptop. That runs into a friction: the seed
config (`clusters/pr-watch/engine/seed/config.json`) has to be committed so the cluster is
self-installable, but it can't carry an individual teammate's identifiers — GUS user id, the
repos they watch, their Slack channel, their team's sprint pattern. Publishing those would
leak private-ish state and force every teammate to fork just to change a channel name.

The sanitize sweep (Phase 2C, ADR-0087 sibling work) replaced those identifiers with generic
placeholders (`owner/repo`, `#your-team-channel`). The seed is now safely publishable — but the
loop won't do useful work on a teammate's machine until the placeholders get resolved to real
values somehow.

## Decision

The engine's `load_config()` reads three layers, in overlay order (later wins):

1. **Seed** (`engine/seed/config.json`) — generic, committed, safe to publish.
2. **Runtime** (`~/.ccs/clusters/pr-watch/cluster/config.json`) — per-machine copy that a
   first-run bootstrap writes; not committed anywhere.
3. **`.env` overlay** (`clusters/pr-watch/.env`) — a gitignored file plus ambient env vars,
   read on every `load_config()` call. Ambient env wins over the file (for scripted overrides).

The `.env` file lives alongside the cluster's other config, not in the repo root — a monorepo
of clusters can have per-cluster envs. A committed `.env.example` documents every recognized
variable.

Vocabulary is a fixed prefix (`PR_WATCH_*`) so an ambient env var can't accidentally shadow
another cluster's config. First round of overlay keys:

- `PR_WATCH_GUS_USER_ID` → `gus.userId`
- `PR_WATCH_GUS_TEAM_SPRINT` → `gus.teamSprintLike`
- `PR_WATCH_REPOS` (comma-separated) → `repos`
- `PR_WATCH_SLACK_CHANNEL` + `PR_WATCH_SLACK_CHANNEL_ID` → `slack.{channel,channelId}`
- `PR_WATCH_CX_CHANNEL` → `cx.channel`

Unset variables leave the underlying config untouched (fail-open). No error is thrown for a
missing `.env` — a teammate who's happy with the runtime copy can skip it entirely.

## Consequences

- The seed can stay generic. `#your-team-channel` in the seed is a real placeholder, not a
  bug, because every real deployment will overlay its actual channel name via `.env`.
- New per-user knobs land here without touching the schema: add a case to `_apply_env_overlay`
  + a line to `.env.example`. No migration needed.
- Ambient env still trumps the file, so a one-off `PR_WATCH_REPOS=foo/bar python3 sense.py`
  works for debugging without editing the `.env`.
- Nothing else changes for existing users: their `~/.ccs/clusters/pr-watch/cluster/config.json`
  still resolves the same values, since the overlay only fires when its env var is set.

## Not doing

- **Not** switching to a full config framework (Dynaconf / Hydra / pydantic-settings). Two
  layers + a flat env prefix is enough; a framework buys features we don't need yet.
- **Not** overlaying arbitrary paths (e.g. `PR_WATCH_gus__userId`-style). The whitelist is
  small enough that hand-mapping in `_apply_env_overlay` beats a generic path parser.
- **Not** doing multi-cluster env vars (a `PR_WATCH_` prefix scopes this to pr-watch by
  design). The next cluster gets its own prefix and its own `.env.example`.

## References

- [[phase-1-hardening-2026-07-14]] — original shareability plan that motivated this.
- [[adr-0087-epic-hooks-runtime]] — parallel Phase 2 shareability fix (epic content out of
  the shared config repo).
