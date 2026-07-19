# A cluster is a self-contained config package; definition files are the source of truth, sqlite is not

Supersedes the source-of-truth half of ADR-0022 (the sqlite `roles` table is authoritative).
Decided with Milad 2026-07-10 after an architecture review (cross-checked with GPT-5.5) found a
single cluster scattered across FOUR locations. Design docs: the v2 self-containment review.

> **Amended 2026-07-10 (same session):** the engine-stays-a-separate-repo decision below was
> reversed. Milad chose full self-containment: the executable engine is FOLDED INTO the package
> at `clusters/<c>/engine/` (monorepo). The old external repo (`~/Documents/pr-watch-2`) was
> decommissioned — skills/commands became real files, the engine moved to `engine/`, all
> invocation paths repointed to engine-relative. A clone of `~/.ccs-config` now runs a cluster
> with ZERO external dependency. See "The cluster's executable ENGINE" bullet, superseded inline.

## The problem

"Where is the pr-watch cluster?" had four answers: (1) role dirs + hooks in `~/.ccs-config`,
(2) a DUPLICATE `roles` table in `~/.claude-sessions/catalogue.db` (home_dir/kind/
resume_command/hooks — same data), (3) skills/commands symlinked in from a THIRD repo
(`~/Documents/pr-watch-2`), (4) runtime state in `~/.ccs`. To move, share, or delete a cluster
you touched four places across three git repos plus an untracked sqlite file. That is the
opposite of self-contained, and the sqlite `roles` table being "the source of truth" (ADR-0022)
meant a cluster's definitions weren't even versioned in the config repo.

## Decision — a cluster is ONE package; its definition files are truth

- **A cluster is a self-contained directory** under `~/.ccs-config/clusters/<cluster>/` holding
  its whole DEFINITION: `cluster.toml`, per-role dirs, skills/commands as REAL files, and
  layered `.ccs-hooks/`. Moving/sharing/deleting the cluster = moving one directory (plus its
  runtime under `~/.ccs`, ADR-0041).
- **Config files are the source of truth. sqlite holds no authoritative definitions.** The
  `roles` table is DROPPED (ADR-0050); readers read the files directly. This is the same
  files-are-truth model `index.db` already follows (a cache of the Store, deletable).
- **A role directory holds a `role.toml`** carrying ONLY the non-derivable metadata: `kind`
  (loop|session) and `resume_command`. Everything else is DERIVED: the role name is the dir
  name, the cluster is the parent path, the home is where the file sits (no stored absolute
  path — the portability breaker is gone), and skills/commands/hooks membership is
  file-presence (consistent with ADR-0043's enrollment rule).
- **skills/commands are real files in the package**, never symlinks into a third repo. This
  completes the #32 portability fix — a clone has no dangling links.
- **The cluster's executable ENGINE lives IN the package** at `clusters/<c>/engine/` (monorepo;
  amended from the original "separate tool-repo" — see the banner above). Its scripts self-locate
  (package-relative), so the package runs from wherever it's cloned. `cluster.toml` names it.
  ~~[superseded] a separate tool-repo referenced by `cluster.toml`,~~
  invoked via commands (not machine-absolute paths) — mirroring how ccs-the-tool is separate
  from `~/.ccs-config` (ADR-0041). The package is self-contained AS A DEFINITION; the engine is
  a declared dependency, like ccs itself. (pr-watch's Python `scripts/`+`lib/` stays its repo.)

## Consequences

- A cluster is movable/git-diffable/shareable as a unit; adding one is "drop a package + sync."
- role.toml is the human front door; the file layout carries the rest. No absolute paths stored.
- Supersedes ADR-0022's "sqlite registry is the source of truth for role DEFINITIONS." Roles are
  still first-class (the rest of 0022 stands); their truth is now files.
- Interacts with ADR-0050 (drop the roles cache, read files) and ADR-0051 (materialization
  re-sourced from files).
