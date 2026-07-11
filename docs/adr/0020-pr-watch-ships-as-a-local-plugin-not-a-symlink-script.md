# [SUPERSEDED by ADR-0022] pr-watch-2 ships as a local Claude Code plugin

> SUPERSEDED 2026-07-09, same day it was written. Milad decided the plugin should go;
> the discovery + hook-wiring jobs move to a ccs-owned ROLE REGISTRY that materializes
> roles into `~/.claude` (ADR-0022). The reasoning below about WHY install.sh's
> hand-maintained list is fragile still holds — the fix is the registry, not a plugin.
> Kept for the record; do not implement this ADR.

Resolves the "command/skill discoverability" fragility (the scout wasn't found live
because it was committed but never added to `install.sh`'s hand-maintained symlink
list) and the fragile hand-editing of `~/.claude/settings.json` for hooks. Decided
with Milad 2026-07-09 after confirming plugin mechanics against Claude Code docs.

## The fragility being replaced

`install.sh` today does two brittle, manual things:
1. Symlinks each command + skill into `~/.claude/` from a HAND-MAINTAINED list of
   `link` calls. Add a new command (the scout) but forget the two `link` lines → it
   is never discoverable. This already happened: the live scout session hit "Unknown
   skill: pr-watch-scout" and had to read the command file by hand.
2. Hand-edits `~/.claude/settings.json` to wire the worker Stop hook (idempotent, but
   still a bespoke JSON-surgery step per hook we add).

Both are "forgot to update the manual step" traps.

## Decision

pr-watch-2 is packaged as a local Claude Code PLUGIN, distributed via a LOCAL
marketplace (a git repo / on-disk path — nothing published publicly). `install.sh`'s
symlinking + settings-surgery is retired.

Structure:
```
pr-watch-2/
  .claude-plugin/plugin.json        # name: pr-watch-2, version, description
  skills/    <role>/SKILL.md         # AUTO-discovered — no list to maintain
  commands/  *.md                    # AUTO-discovered
  hooks/hooks.json                   # Stop + SessionStart hooks, AUTO-wired on enable
  scripts/, lib/, seed/, docs/       # unchanged
```
Installed via `/plugin marketplace add <local path/repo>` then `/plugin install
pr-watch-2@<marketplace>` (or `enabledPlugins` in settings).

What this fixes structurally:
- **Auto-discovery** — every `skills/<name>/SKILL.md` and `commands/*.md` is discovered
  from disk. Add a new role/command, commit; it appears. No manifest edit, no `link`
  line, no rerun-install. The scout-class bug cannot recur.
- **Hooks auto-wire** — `hooks/hooks.json` declares the worker Stop hook AND the new
  SessionStart registration hook (ADR-0017); enabling the plugin wires them. No more
  hand-editing `~/.claude/settings.json`.
- **Versioned + distributable** — a local marketplace gives update-on-startup and a
  single `/plugin install` for any machine, instead of clone + run install.sh.

## Accepted consequences

- **Command namespacing changes the invocation.** Plugin skills are namespaced:
  `/pr-watch-2:pr-watch-control` (or similar) rather than `/pr-watch-control`. This is
  a rename of how commands are invoked; every launcher, `/loop` command string, and
  `resume_command` (ADR-0015) must use the namespaced form. Accepted as a cleaner end
  state; noted because it touches the arming strings.
- **New skills need a reload to appear in a LIVE session.** Auto-discovery + a startup
  marketplace update means NEW sessions see new skills automatically, but an
  already-running session needs `/reload-plugins`. Fine for our model — we turn the
  cluster on deliberately (loop lifecycle is manual, per the loop-lifecycle decision),
  so a new session picking it up is the normal path.

## What this does NOT solve (scope boundary)

- **Per-directory scoping.** Plugins scope by install location (user / project /
  local), NOT per directory. So the marketplace organizes + versions + distributes the
  skills, but it does NOT give "only the scout session sees scout skills" scoping. That
  kind of scoping is the per-role-directory idea (ADR-0018), a SEPARATE concern.
  Distribution/discovery = plugin (this ADR); hook/permission scoping = per-role dirs
  (0018). Keep them distinct.

## Consequences for the fragility list

- "Command/skill discoverability" fragility → resolved by construction (auto-discovery).
- The worker Stop hook wiring moves from install.sh's JSON surgery into
  `hooks/hooks.json`; the ADR-0017 SessionStart hook ships the same way.
- `install.sh` is retired (or reduced to a thin "add the local marketplace" helper).
- Migration note: existing symlinks in `~/.claude/commands`/`skills` must be removed
  when the plugin is adopted, to avoid a command existing both as a symlink and a
  plugin entry.
