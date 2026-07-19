# One directory per role; the role dir scopes both PERMISSIONS and role-specific HOOKS — global hooks stay global, and the two MERGE

> **Superseded (implementation) by ADR-0043 (2026-07-10).** The "role-dir `.claude` carries
> role hooks, resolved by Claude Code" mechanism did NOT hold in practice — CC anchors settings
> discovery to the session's cwd, which for a fleet worker is a PR worktree, not the role dir.
> ccs now resolves layered hook config ITSELF from the session's row (ADR-0043), so role hooks
> work regardless of cwd. The permissions-scoping half of this ADR still stands; the
> hook-resolution half is superseded.

Follows ADR-0014 (identity is the responsibility, cwd is derived and NOT identity).
Rewritten 2026-07-09 after verifying hook-resolution mechanics against the official
Claude Code docs — the previous version's "Correction" (hooks resolve only at the repo
root, so role dirs can't carry hooks) was WRONG and is retracted here.

## The mechanics, verified

Confirmed against docs.claude.com (hooks + permissions + settings references):

- **Hooks load from the cwd's `.claude/` folder**, with NO parent-directory fallback. So a
  session launched with its cwd = a role directory DOES discover and fire that directory's
  `.claude/settings.json` hooks. (The old claim "hooks only resolve at the repository root,
  never per-subdirectory" is false — the cwd itself is the project scope.)
- **Hooks MERGE across settings tiers, they do not override.** When an event fires, ALL
  matching hooks from every scope (user `~/.claude/settings.json`, project/cwd
  `.claude/settings.json`, `.claude/settings.local.json`, managed, plugin) run in parallel;
  identical commands are deduplicated. Hooks behave like `permissions` (array-merge), NOT
  like scalar settings such as `model` (highest-tier-wins). Quote: "When an event fires,
  all matching hooks run in parallel, and identical hook commands are automatically
  deduplicated."
- **Permissions** (`settings.local.json`) also load from the cwd and merge across scopes;
  **statusLine** loads from the cwd's settings too.

So the cwd's `.claude` is a real scope for hooks, permissions, and statusLine — and because
hooks merge, per-role hooks stack ON TOP OF global hooks rather than replacing them.

## Decision

Each role gets its own directory, and its cwd = that directory (ADR-0036). That
directory's `.claude` carries the role's **permissions + role-specific hooks + statusLine**.
Global, cluster-wide hooks stay in the user-level settings. Both fire, by merge.

- **Global hooks (`~/.claude/settings.json`)** — fire for EVERY session regardless of role.
  This is where the cluster-wide **ccs registration/arming SessionStart hook** and the
  **worker/self-report Stop hook** live: anything that must run for all identities.
- **Role hooks (`<role-dir>/.claude/settings.json`)** — fire ONLY for sessions running in
  that role dir. This is where a role customizes itself: a control-specific SessionStart
  that reloads the board, a pr-agent Stop that records gate verdicts, a role's PreToolUse
  guard, etc.
- The two **merge**: a `pr-agent` session fires the global registration SessionStart AND its
  own role SessionStart. No override, no conflict, no need to re-declare global hooks in the
  role dir.
- cwd is a permission/hook SCOPE and a role HINT, explicitly NOT identity (identity is the
  responsibility, ADR-0014/0026). Multiple sessions may share a role dir with no collision
  (every `pr-agent` shares the one `pr-agent` dir, ADR-0036).

## Self-filtering is now the exception, not the rule

Because role dirs carry role hooks directly, a hook does NOT need to self-filter by role in
the common case — you simply place role-specific hooks in the role dir and global hooks in
user settings. Self-filtering (a globally-wired hook that inspects the `cwd`/`session_id` in
its stdin payload and no-ops for the wrong role) remains available for the rare case where a
hook must be globally wired yet behave conditionally, but it is no longer the required
pattern the previous version assumed.

## How role hooks get INTO the role dir

ccs materialization (ADR-0022/0034) writes each role's hooks + settings into its role
directory (inside a managed block, ADR-0034), from the roles registry. Global hooks are
materialized once into `~/.claude/settings.json` (also a managed block). So both layers are
generated declaratively from the registry; neither is hand-maintained.

## Why this is safe (it wasn't before 0014)

Pre-0014, "one dir per role" would have been load-bearing for identity (the resolver keyed
on cwd). Post-0014 identity is the responsibility, so a shared role dir is purely config
locality and reintroduces no "one session per cwd" limitation.

## Consequences

- Role-specific hooks AND permissions AND statusLine all scope cleanly to the role dir;
  global hooks stay global; everything merges — the exact layering pr-watch needs (ccs
  registration everywhere + per-role customization).
- ADR-0017's registration hook is a GLOBAL hook (fires for all sessions); a role's own
  arming/setup is a role hook. They stack.
- Supersedes this ADR's earlier "hooks ship only via the global registry and self-filter"
  framing: role hooks in the role dir are first-class again.
- Build: materialization writes global hooks to user settings and role hooks to each role
  dir, both in managed blocks (ADR-0034).
