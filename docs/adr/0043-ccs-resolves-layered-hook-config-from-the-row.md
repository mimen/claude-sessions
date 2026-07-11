# ccs resolves layered hook config from the session's row — global-fired, identity-resolved

Supersedes the "hooks ship global + self-filter in handler code" model (ADR-0018's current
implementation) with a declarative, layered configuration system. Decided with Milad
2026-07-10; sharpened by a cross-model (GPT-5.5) design review the same day. Design docs:
`docs/hook-resolution-draft.html` + `docs/hook-instantiation-pr-watch.html`.

## The problem

Today a ccs hook's behavior is hardcoded in the handler, which self-filters by inspecting the
session's catalogue row (`if role then …`). The only knob is "what a programmer wrote." We want
behavior configurable per level — a universal base, then progressively more specific additions
or overrides for a cluster, role, epic, or identity — WITHOUT inventing new Claude Code events
and WITHOUT relying on CC discovering config in a role folder (it anchors discovery to the
session's cwd, which for a fleet worker is a PR worktree, not the role dir).

## Decision — ccs is the resolver; config is layered files keyed by identity

- **Custom hook TYPES ride existing CC events.** `claude-md`, `start`, `stop`, `meta-update`,
  `cmux-paint`, `statusline`, `spawn-location` (+ future `guard`). Each attaches to a real CC
  event (SessionStart/Stop/PreToolUse) or a ccs moment (new-session, tick). We never invent CC
  events. The statusline (ADR-0027) is the proof-of-concept: a "type" that isn't a CC event,
  routed to its own slot.
- **Resolution walks the identity broad→specific FROM THE ROW.** When a hook fires, ccs has the
  `session_id` on stdin → the row → an ordered level list: `user → cluster → role → epic →
  work-unit → identity`. Each level MAY contribute exactly one file at a fixed path
  `<levelDir>/.ccs-hooks/<type>.{md,json}`. This resolves identically regardless of the
  session's cwd — the concrete resolution of the ADR-0018 tension (CC can't find role-dir
  config; ccs can, from the row).
- **Enrollment = file-presence.** A level participates in a hook type simply by having the file.
  No capabilities list to keep in sync; the roles-registry `hooks:[…]` array is retired for
  these custom types. (Requires `ccs hooks lint` — see ADR-0045 — since a typo silently
  un-enrolls.)
- **`spawn-location` is the one pre-row exception.** It fires at `new-session`, before a row/
  session_id exists, so it resolves from the LAUNCH REQUEST (responsibility spec: role →
  registry `home_dir`, or a per-work-unit worktree resolver), launches there, then binds the
  location onto the row. Modeled as a distinct lifecycle from the row-based hooks.

## Levels — all six ordered; build only some now

Order is fixed (also the merge order). Build **user + cluster + role** now, plus **epic for
`claude-md` only** (it carries durable initiative knowledge — see the pr-watch epic gotchas —
that otherwise gets repeated in every dispatch prompt). Defer **work-unit + identity** file-
backed config until a concrete incident role/epic config can't solve (that's where GC +
complexity spike). Keep the resolver ordered for all six regardless.

## Config roots (ADR-0041)

user/cluster/role/epic configs are DEFINITIONS → `~/.ccs-config` (git). The identity level is
runtime/ephemeral (about a live work-unit) → `~/.ccs` (never git), and when used is logged with
a content hash for reproducibility.

## Consequences

- Handlers stop hardcoding role branches; they read the resolved config. Role-specificity comes
  from the config tree, not from `if` ladders.
- `claude-md` becomes CONTEXT COMPOSITION: a session's briefing is the layered merge of every
  applicable level's `claude-md.md` — so every embodiment understands the invariants + its role
  + its epic automatically, resolved from identity (see ADR-0044 for the merge rules).
- Supersedes ADR-0018's implementation framing; amends ADR-0029 (a role still owns its upkeep,
  but via resolved config not bespoke scripts). The merge contract is ADR-0044; determinism +
  observability is ADR-0045.
