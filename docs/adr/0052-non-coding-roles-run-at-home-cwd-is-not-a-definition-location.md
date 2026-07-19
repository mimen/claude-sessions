# A non-coding role runs at $HOME; the role's cwd is decoupled from its definition directory

Decided with Milad 2026-07-10 after a rename (`scout` → `slack-scout`) orphaned a live
session's resume. Finishes the cwd-decoupling that ADR-0046 started, and closes the
resume-fragility hole ADR-0021 (Issue 2) believed we were already immune to.

## The incident that forced this

We renamed the role dir `roles/scout` → `roles/slack-scout`. A live session (`2ed1df23`)
had been *born* with its cwd = `…/roles/scout`. Claude Code files a transcript at
`~/.claude/projects/ENCODE(birth_cwd)/<id>.jsonl` and, on `--resume <id>`, looks ONLY in
`ENCODE(current_cwd)` — it takes no file path, so the birth cwd is a hard dependency. The
rename deleted the one directory that encodes to the transcript's storage folder, so:

- `ccs resume-cluster` ran the correct resolver, but `locateLaunchDir`'s filesystem walk
  found NOTHING (the dir was gone), fell back to project-root, and emitted a launch that
  could never succeed → `No conversation found with session ID: 2ed1df23…`.

The transcript was never lost — it sat safely in its storage folder the whole time. What
broke was the *launch pad*: the birth cwd. ADR-0021 claimed our resume was "immune" because
the resolver walks the filesystem for the anchor dir; the incident proved the immunity has a
hole — **a walk can't find a directory that was deleted.**

## The root realization — the run-location cwd was doing a job it shouldn't

A role's directory (`clusters/<c>/roles/<role>/`, ADR-0048) is a DEFINITION home: it holds
`role.toml`, `skills/`, `commands/`, `.ccs-hooks/`. Using that same directory as the
session's runtime **cwd** silently coupled two unrelated things:

- the DEFINITION location (renamed/reorganized freely as config evolves), and
- the RUNTIME anchor (immutable for the life of a session, because CC bakes it into the
  transcript's storage-folder name at birth).

Renaming a definition is a normal config operation; it must not be able to strand a running
session. The coupling is the bug. And post-ADR-0046 nothing requires it: `claude-md` is a
row-injected hook, hooks/permissions resolve from the row (ADR-0043), and identity is the
session id, not the cwd (ADR-0014/0018). So for a role that operates on **no repository**,
the cwd carries no load at all — it is a pure naming anchor.

## Decision — a non-coding role runs at $HOME

- **A role that operates on no coding project runs with cwd = `$HOME`.** This covers every
  current pr-watch role except `pr-agent`: the loops (`slack-scout`, `control`, `concierge`,
  `eval`) and `designer`. Their cwd conveys nothing (context arrives via the `claude-md`
  hook; identity via the row), so a single stable, never-renamed anchor is strictly better.
- **A coding role keeps cwd = its worktree.** `pr-agent` still launches in the per-work-unit
  git worktree (`spawn-location: "worktree"`, ADR-0046) — it genuinely needs repo cwd for
  `git`, diffs, relative paths, and the repo's own conventions.
- **`spawn-location` gains a `"home"` mode** resolving to `$HOME` at launch. It is PORTABLE
  by construction — a clone on another machine resolves to that machine's `$HOME`, with no
  hardcoded absolute path. `"home"` becomes the default for non-coding roles; `role-dir`
  stays available but is no longer the recommended run-location (it re-introduces the
  rename-orphan hazard). `"worktree"` and `"<abs-path>"` are unchanged.
- **The role's DEFINITION directory is unaffected.** `roles/<role>/` still holds the role's
  files; it is simply no longer the session's cwd. Definition location and run-location are
  now fully independent — renaming a role dir can never orphan a running session again.

## Why $HOME specifically (not a shared `clusters/<c>/run/` dir)

$HOME already exists on every machine, is never renamed, and needs no creation step — a
clone is immediately runnable. A bespoke shared run-dir would reintroduce a
package-relative path that must exist before launch (a portability + bootstrap cost) to buy
nothing, since the cwd conveys no role information anyway. If a future need arises to
partition run-locations (e.g. per-cluster), it can be a later config value; today $HOME is
the simplest anchor that satisfies the constraint.

## Consequences

- **The rename-orphan bug class is eliminated for non-coding roles.** $HOME can't be renamed
  away, so their sessions are always resumable regardless of how role definitions are
  reorganized. Only `pr-agent` retains a mutable birth cwd (its worktree) — a smaller,
  well-understood surface handled by the worktree lifecycle.
- **Migration:** flip each non-coding role's `spawn-location` to `"home"`. EXISTING live
  sessions born under a role-dir cwd keep that birth cwd (immutable) until they end — they
  are migrated by moving their storage folder to match, exactly as `2ed1df23` was recovered
  by hand (move `~/.claude/projects/ENCODE(old)/…` → `ENCODE($HOME)/…` + reindex). New
  embodiments launch at $HOME.
- **Amends ADR-0036/0018's "cwd = role dir."** 0036 was already superseded (0046) for the
  claude-md constraint; this removes the last reason to run in the role dir. The
  permission-scoping story is unchanged — permissions come from row-resolution +
  `additionalDirectories` (ADR-0046), not from the cwd's `.claude`.
- **Follow-up (separate, scoped out here):** two residual resume-path hardening items remain,
  independent of this decision — (1) locate the transcript live by session-id (glob the
  store) rather than trusting the cached index `path`, so a *moved transcript* still resolves;
  (2) make the launch-dir resolver, when no directory encodes to a transcript's storage
  folder, RECREATE that directory (or realign the storage folder) instead of falling back to
  a guaranteed-to-fail cwd. This ADR removes the hazard for non-coding roles; those two
  harden the remaining `pr-agent`/worktree case and the moved-transcript case.
- **Tooling:** a future `ccs role rename` (and the new-cluster/new-role front door) must
  migrate storage folders + reindex atomically, so a rename never again desyncs a live
  session's birth cwd from its definition. Recorded here so it's designed in, not rediscovered.
