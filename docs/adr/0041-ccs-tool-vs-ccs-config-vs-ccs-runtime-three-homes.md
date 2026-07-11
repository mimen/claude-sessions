# Three homes: the ccs TOOL, ~/.ccs-config (definitions, git), ~/.ccs (runtime, never git)

> **Amended by ADR-0049 (2026-07-10).** The three homes stand, but the tool's SQLite lived in
> a silent FOURTH (`~/.claude-sessions`); it is retired and its contents move under `~/.ccs`
> (runtime/caches), restoring one-responsibility-per-home.


Emerged while trying to seed the roles registry (ADR-0022): "where do role folders /
identities / inboxes physically live?" had no clean answer because three different things
were being conflated into one location. This ADR separates them. Decided with Milad
2026-07-09. Refines ADR-0031 (state paths) and ADR-0034 (manifest path); the earlier
`~/.ccs/clusters/<c>/*.json` for cluster state is superseded by the split below.

## The three things (previously conflated)

1. **The ccs TOOL** — the code. Generic, shareable, could be published. Knows nothing about
   any specific cluster. Lives where it already does: `~/projects/claude-sessions/` (its own
   repo). Unchanged by this ADR.
2. **CONFIG / definitions** — what roles + clusters exist and how each is wired (skills,
   commands, settings, resume_command, membership). Authored by a human, versioned,
   shareable across machines. This is the roles registry made concrete on disk.
3. **RUNTIME / state** — what the running fleet generates: identities, inboxes, results,
   judgments, the cluster board/gate/dispositions. Machine-local, changes constantly, and
   crucially **contains routed Slack messages + PR feedback** (the scout drops teammates'
   comments into worker inboxes).

The bug in conflating them: if runtime lived inside a cluster's git repo, a `git push` would
LEAK inbox content (real people's Slack messages) to GitHub. Config wants to be pushed;
runtime must never be. They cannot share a root.

## Decision — two top-level roots, split by config-vs-runtime

```
~/.ccs-config/                    ← CONFIG. ONE git repo. Authored + versioned + shareable.
  clusters/
    pr-watch/
      roles/<role>/   { skills/, commands/, settings.json }   ← the role folder = its home
      cluster.json                                            ← membership + cluster config
    event-watch/  …
  roles/<role>/       { skills/, commands/, settings.json }   ← standalone (non-cluster) roles

~/.ccs/                           ← RUNTIME. NEVER git, never pushed. Machine-local.
  clusters/<cluster>/
    identities/<role>/[<epic>/]<work-unit>/
      inbox/  processed/  result.json  judgment.json          ← per-identity state (ADR-0033/0031)
    cluster/  { board.json, gate.json, dispositions.json }     ← cluster shared state (ADR-0031)
  roles/<role>/
    identities/<work-unit-or-singleton>/
      inbox/  processed/  result.json  judgment.json           ← standalone-role identities
  materialization-manifest.json                                ← ccs's symlink-cleanup receipt (ADR-0034)

~/projects/claude-sessions/       ← the ccs TOOL (code, own repo). Reads/writes both roots.
~/.claude/                        ← Claude Code's own dir. sync-roles symlinks into it.
```

The split is at the TOP level, deliberately: config-vs-runtime is the first cut, then
clusters-vs-standalone is the second cut ON BOTH sides (symmetric). So the two trees mirror
each other — a cluster role's config is `~/.ccs-config/clusters/pr-watch/roles/control/`, its
runtime is `~/.ccs/clusters/pr-watch/…`; a standalone role's config is
`~/.ccs-config/roles/<role>/`, its runtime is `~/.ccs/roles/<role>/…`.

## Why these boundaries

- **Leak-proof by construction.** Inbox content lives under `~/.ccs/`, which is simply not a
  git tree — no per-cluster `.gitignore` to get wrong. You could `rm -rf ~/.ccs` to wipe all
  runtime without touching a single definition. Pushing an inbox is structurally impossible.
- **`~/.ccs-config/` is ONE git repo** (Milad, 2026-07-09): all clusters + standalone roles +
  machine config, versioned together, one clone = the machine's whole fleet config. (We
  considered per-cluster repos — "clusters are a good granularity" — but chose one repo for
  simplicity; revisit IF a second machine needs à-la-carte clusters. The pr-watch repo folds
  IN as `clusters/pr-watch/`.)
- **The role folder is the role's home** (ADR-0018/0036): its `skills/`, `commands/`, and
  `settings.json` colocated in `~/.ccs-config/.../roles/<role>/`, and that folder is the cwd
  its sessions run in. Colocating skills there does NOT complicate sync-roles — Claude Code
  discovers from the flat `~/.claude/{skills,commands}/`, so it's one symlink per asset
  regardless of where the source sits.
- **Per-machine identity.** Milad's work laptop and personal machine each get their own
  `~/.ccs-config/` repo + their own `~/.ccs/` runtime — different fleets, no shared state.

## Consequences

- **ADR-0031 refined:** cluster state moves from `~/.ccs/clusters/<c>/*.json` to
  `~/.ccs/clusters/<c>/cluster/*.json`, and identity state to
  `~/.ccs/{clusters/<c>|roles}/<…>/identities/<key>/`. The storage contract (atomic, versioned,
  single-writer-per-field) is unchanged — only the paths.
- **ADR-0034 refined:** the manifest lives at `~/.ccs/materialization-manifest.json` (runtime —
  it records THIS machine's current symlinks, not a definition). Role folders it links FROM are
  under `~/.ccs-config/`; global targets are `~/.claude/`.
- **ADR-0022 completed:** the roles registry (the catalogue `roles` table) is the queryable
  index; `~/.ccs-config/.../roles/<role>/` is where each role's actual files live. A role's
  `home_dir` = its config folder.
- **Todo (not this ADR):** reinitialize the session-architecture repo at `~/.ccs-config/` with
  this shape and migrate pr-watch's live assets (commands/, skills/, state) into it — a careful
  step because the cluster is running. Seeding the registry + finishing sync-roles waits on that
  reinit. The already-built ccs code (bridge, resume, registry, sync-roles) stays; only the seed
  location changes.
- **cluster.json** (per-cluster membership/config) is new — the concrete form of "a cluster is
  an optional grouping" (ADR-0009/0022); its exact fields are a build detail.
