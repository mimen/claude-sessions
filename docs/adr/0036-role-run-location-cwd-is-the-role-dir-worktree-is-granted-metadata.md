# A role's run-location is a single fixed dir; the worktree is per-work-unit metadata, granted — not the cwd

> **Superseded by ADR-0046 (2026-07-10).** This ADR's "one real tradeoff" (cwd = role dir, so
> the repo's CLAUDE.md doesn't auto-load) evaporated once `claude-md` became a ccs hook injected
> from the row (ADR-0043/0046): CLAUDE.md loading is no longer tied to cwd, so `spawn-location`
> is now free per-role config — a worker launches in its worktree (regaining repo context) while
> permissions still come from row-resolution + `additionalDirectories`. The uniform-permissions
> win this ADR sought is preserved; the fixed-dir constraint is lifted.

ADR-0022 gives a role a "home directory." ADR-0018 says that directory carries the role's
PERMISSIONS. But fleet workers (pr-agent) each operate on their OWN git worktree, and a
design review flagged that a single home-dir field can't express "one per work-unit."
Today pr-watch resolves this by spawning each worker with its cwd INSIDE the worktree and
injecting a per-worktree `.claude/settings.local.json` (`grant_worktree_perms`) — the
drift-prone, per-instance wiring the whole materialization model is trying to eliminate.
Decided with Milad 2026-07-09.

## The key realization — the session need not live inside the worktree

A Claude Code session has a cwd, but file work is not confined to it: Bash can `cd` /
`git -C <path>`, and the file tools take absolute paths. And the thing that historically
forced cwd = worktree is gone — liveness no longer needs cwd to tell workers apart
(ADR-0014 keys liveness on the recorded cmux ref), so many `pr-agent` sessions can share
one role-dir cwd without collision. The worktree can be created separately; the session,
living in its role dir, knows where the worktree is and operates inside it.

## Decision — cwd = the role dir; worktree = granted metadata

- **A role's run-location is a single fixed directory.** Not a union, not a template.
  `control` lives in its role dir; every `pr-agent` shares the ONE `pr-agent` role dir.
  That directory's `.claude` carries the role's permissions + settings, materialized
  uniformly from the registry (ADR-0018/0022/0034). Every worker of a role is wired
  identically — no per-instance injection.
- **The worktree is per-work-unit metadata, delivered two ways at `new-session`:**
  1. **stored on the session's ccs metadata** — the worktree path, so the worker knows
     where to operate (`git -C <worktree>` / absolute paths);
  2. **granted via `additionalDirectories`** — the role's materialized settings grant the
     worker write access to its specific worktree path (resolved per work-unit at spawn),
     so a role-dir cwd can still write outside itself.
- **`grant_worktree_perms` (per-worktree `settings.local.json` injection) retires.**
  Permissions come from the role's materialized settings + the `additionalDirectories`
  grant, never from a file written into each worktree.

## The one real tradeoff — repo project-context no longer auto-loads

When cwd is inside the `heroku/dashboard` worktree, Claude Code auto-loads that repo's
`CLAUDE.md`, its `.claude` hooks, its lint config — which a PR author generally wants.
With cwd = role dir, that auto-loading does NOT happen. Milad chose cwd = role dir anyway
(2026-07-09) for the uniform-permissions win; the cost is explicit and owned:

- **Re-injecting the repo's conventions is pr-watch's job, not ccs's.** The worker's
  briefing points at the target repo's `CLAUDE.md` / conventions explicitly (read-it
  instruction + path). This is a pr-watch briefing item on the role-definition checklist
  (ADR-0029), not a ccs concern.

## Consequences

- The role registry's location field stays a single path per role — the model in ADR-0022
  holds without a per-role union/template.
- The materialization story is now consistent end-to-end: role dir → uniform `.claude`
  permissions/settings for every embodiment of the role, plus a per-work-unit
  `additionalDirectories` grant. No per-worktree injected files means nothing to drift or
  leave stale (the ADR-0034 goal, applied to worker permissions).
- pr-watch build: `spawn-agent.sh` still CREATES the worktree (that's cluster policy, not
  ccs), but no longer writes `.claude/settings.local.json` into it; it passes the worktree
  path to `ccs new-session` (stored as metadata + turned into the `additionalDirectories`
  grant), and the briefing gains the "read the target repo's CLAUDE.md" pointer.
- ccs stays worktree-agnostic in its model: it knows a session has a run-location (role
  dir) and zero-or-more granted directories; it does not model "worktrees" as a concept.
