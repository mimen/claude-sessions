# Role skills and commands are discovered project-level, not materialized user-level

Revises ADR-0034/0048's materialization model. Decided 2026-07-12 after verifying that Claude Code
discovers BOTH slash-commands and skills from `<cwd>/.claude/` for any nested directory (project-
level discovery walks up to the repo root). Since core roles launch with spawn-location "role-dir"
(their home has a `.claude/` subdir), commands and skills can be discovered project-level from the
role directory — no need to litter `~/.claude` with per-role symlinks.

## The problem

Every role's skills and commands were symlinked into `~/.claude/skills` and `~/.claude/commands`
(ADR-0034 materialization model), littering the USER-level namespace. A typical 4-role cluster
installed 8+ skills and 4+ commands into the user's `.claude`, visible to EVERY session regardless
of context. This worked (Claude Code sees user-level resources everywhere) but:
- It cluttered the global namespace — skills/commands from all clusters show up in every session.
- It required materialization reconcile on every `ccs sync-roles` run.
- It broke the "a cluster is self-contained" promise (ADR-0048) — cluster resources were projected
  into `~/.claude`, not just read from the cluster's package.
- It was unnecessary: Claude Code already discovers commands + skills project-level from the cwd's
  `.claude/` subdirectory, and core roles (control, concierge, scout) launch in their role dir.

## Decision — project-level discovery, no user-level symlinks

- **Role skills and commands live in `<role-dir>/.claude/skills/` and `<role-dir>/.claude/commands/`**
  (project-local), discovered by Claude Code from the role's cwd when the session spawns. No
  per-role symlinks in `~/.claude` — the user-level namespace is reserved for truly global
  resources (the operator's own skills/commands).
- **`role-files.ts` reads from `.claude/skills` and `.claude/commands`** (project-local locations),
  with a fallback to the legacy top-level `skills/` and `commands/` dirs (so nothing breaks before
  the config-side file moves). The derivation remains file-presence driven (ADR-0048).
- **`desiredLinksForRoles` returns EMPTY** (ADR-0074 revision). No per-role skills/commands are
  materialized into `~/.claude`. `sync-roles` prunes any EXISTING ccs-managed skill/command
  symlinks from prior runs (one-time cleanup of the old model), but creates NONE.
- **GLOBAL hooks + statusline REMAIN user-level** (unchanged from ADR-0048 model A). They fire
  for EVERY session (self-filtering by role), so they MUST live in `~/.claude/settings.json` to
  be seen by all sessions. These are the only ccs-managed entries in user-level settings.
- **Workers (pr-agent) were never materialized** (ADR-0034/0048 always exempted them). They get
  their prompt stapled at dispatch time; they never needed user-level resources, and this doesn't
  change that.

## Consequences

- **Cleaner user-level namespace**: `~/.claude/skills` and `~/.claude/commands` no longer hold
  per-role resources — only the operator's own global skills/commands, plus ccs's hooks (which
  truly must be global). The role's skills/commands are visible ONLY when you're in that role's
  session (project-local discovery), not everywhere.
- **No materialization churn**: `ccs sync-roles` no longer reconciles skill/command symlinks on
  every run — only hooks + statusline (which are tiny, unconditional, and rarely change).
- **Cluster self-containment upheld**: a role's resources are read from the cluster package, never
  projected outside it. A clone of `~/.ccs-config` sees a cluster's skills/commands in-place.
- **Config-side file moves required**: the operator moves each role's `skills/*` → `.claude/skills/`
  and `commands/*` → `.claude/commands/` manually (the tool-side fallback ensures nothing breaks
  mid-transition). The ADR lists the affected roles.
- **Discovery depends on git-repo boundary**: Claude Code's project-level discovery walks "up to
  the repository root," so this model assumes `~/.ccs-config/clusters/<cluster>` directories are
  git repos (they should be). If a role dir is outside any repo, discovery may fail (untested).

## Config-side actions

The tool-side change is done (this ADR). The operator must move role files in `~/.ccs-config`:
```bash
# For each role under clusters/pr-watch/roles/<role>/:
mkdir -p <role>/.claude/skills <role>/.claude/commands
mv <role>/skills/* <role>/.claude/skills/   # if skills/ exists
mv <role>/commands/* <role>/.claude/commands/  # if commands/ exists
rmdir <role>/skills <role>/commands           # clean up empty legacy dirs
```
Affected roles (as of 2026-07-12): `pr-watch/{control,concierge,scout}`. Workers (pr-agent) have
no skills/commands to move (they're dispatch-driven, never materialized).
