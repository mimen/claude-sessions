# Role is a first-class ccs entity (optionally grouped by cluster); ccs materializes roles into ~/.claude (no plugin)

> **Amended by ADR-0048/0050 (2026-07-10).** Roles remain first-class, but the sqlite
> `roles` table is no longer the source of truth — definition FILES in the config package are
> (the table is dropped, read from files). The materialization half still holds (ADR-0051).


Supersedes ADR-0020 (the plugin). Refines ADR-0015 (role was a free-form label) and
ADR-0018 (per-role dirs). Decided with Milad 2026-07-09. This is the structural
keystone the identity/arming/hook decisions all hang from.

## The decision in one line

A ROLE becomes a first-class entity in ccs (like the existing `epics` entity), holding
everything needed to run that role, OPTIONALLY grouped by a cluster. ccs is the single
source of truth for "what roles exist and how to run each," and ccs MATERIALIZES them
into `~/.claude` (skills, commands, hooks) from the registry. No Claude Code plugin.

## Cluster is an OPTIONAL grouping lens, not a parent of roles

Important scoping correction (Milad, 2026-07-09): a role does NOT have to belong to a
cluster. Cluster is just a grouping mechanism to help us understand our roles/sessions
(the ADR-0009 constellation > system view) — it is a lens, not a required container. A
role may have a cluster (pr-watch's roles do), or stand alone (a one-off role, a
future role not tied to any operation). So `cluster` on a role row is nullable/optional;
the registry is a flat set of roles that CAN be grouped by cluster for display and for
`ccs resume <cluster>`, not a strict hierarchy where every role must have a parent.

## Why not the plugin (reversing ADR-0020)

The plugin would have owned skill/command discovery + hook wiring. But roles ALSO
relate to a cluster (ADR-0009: constellation > system > core | fleet), and we want ONE
place that knows "the pr-watch cluster has these roles, each lives here, resumes like
this." Splitting that across a plugin manifest (code) and ccs (sessions) creates two
homes for role truth. Making role a ccs entity unifies it: the same registry that
defines a role drives spawning, arming, resume, the cluster view, AND materialization
into `~/.claude`. The plugin's discovery/wiring jobs are absorbed by the registry.

## The roles registry (shape, mirrors the epics entity)

ccs gets a `roles` table, exactly as it has an `epics` table today (entity row +
sessions reference it). A role row holds the RUNTIME wiring:
- `role` (name, e.g. `control`, `scout`, `pr-agent`)
- `cluster`/`system` it belongs to (the ADR-0009 grouping)
- `home directory` — where sessions of this role spawn (the permission/statusLine
  scope, ADR-0018)
- `resume_command` template — how to re-arm on resume (ADR-0015); null for
  non-loop roles like `pr-agent`
- `kind` (loop | session)
- the skills/commands/hooks this role needs materialized into `~/.claude`

A session references its role. Whether that reference is the free-form string
(ADR-0015) or a pointer into this table is an open detail (see below) — but the
registry is the source of truth for role DEFINITIONS regardless.

## Roles CAN be grouped by cluster (optional)

Roles are a flat set that can OPTIONALLY carry a cluster/system grouping (ADR-0009).
The pr-watch cluster groups {control, concierge, eval, scout, pr-agent}. When a role
has a cluster, the registry is queryable as "the roles of cluster X," which is what
`ccs resume <system>` and the cluster map want. A role WITHOUT a cluster is fine — it
just isn't part of a grouped operation. Core roles (singletons: control/eval/etc.) vs
fleet roles (pr-agent, many instances) is the existing core/fleet split, which applies
within a cluster when one is present.

## ccs materializes roles into ~/.claude — a DECLARATIVE reconcile via symlinks

Replacing install.sh's hand-maintained list AND the plugin. The materialization must be
DECLARATIVE, not an accumulating script — Milad's concern (2026-07-09): a "sync script
that adds things" drifts (runs or doesn't) and leaves stale artifacts when a role is
removed, which is the same fragility as install.sh's hand-list relocated.

So the model is: `~/.claude` is a PURE PROJECTION of the registry, reconciled —
- **symlinks, not copies.** Each role's skills/commands are symlinked from the registry
  source into `~/.claude/skills` + `~/.claude/commands`. Verified: Claude Code follows
  symlinks for discovery (the existing pr-watch commands are already symlinks and work).
  A symlink can never hold stale CONTENT — it always points at the live source file.
- **reconcile, with pruning.** The materialize step makes `~/.claude` EXACTLY match the
  registry: create missing links, and DELETE links for roles no longer in the registry.
  Idempotent + self-cleaning: running it twice is a no-op; removing a role removes its
  link. This is what a bare "sync that only adds" fails to do.
- **hooks** are wired the same declarative way (the worker Stop hook, the ADR-0017
  SessionStart hook). Hooks merge across scopes so this is additive; the reconcile owns
  the pr-watch-managed block so it can prune it too.

The key property is that the wiring is a PURE FUNCTION of the registry (declarative,
prunes stale entries), NOT a script that accumulates state. Whether the reconcile is
triggered by a command (`ccs sync-roles`) or a hook is secondary; the property that
matters is idempotent projection with pruning. Because the registry is the source,
adding OR removing a role is one registry edit + a reconcile. No hand-list, no plugin
manifest, no stale artifacts.

## Inbox keying follows from this (see also the messaging ADR)

Because role is first-class and cluster-organized, an inbox keys on the RESPONSIBILITY
a session embodies:
- CORE roles are singletons → inbox keyed by role (`inbox/control/`, `inbox/scout/`).
- FLEET (pr-agent) shares one role across many PRs → inbox keyed by the work-unit each
  worker owns (`inbox/heroku_dashboard-12113/`), NOT by the shared role (which would
  collapse all workers' mail) and NOT by session id (which breaks across resume).
This is the core/fleet split again. Detailed in the messaging ADR (0023).

## Open details (not blocking the decision)

- Does a session store role as the free-form string (ADR-0015) or a pointer into the
  roles table? Leaning pointer (consistent with epic_id), but the free-form label
  works too; deferred.
- Exact `~/.claude` materialization mechanism (symlink vs copy; one `ccs sync-roles`
  command vs per-cluster) — deferred to build.

## Consequences

- ADR-0020 (plugin) is dead. install.sh's hand-list is dead. Discovery + hook wiring
  come from the registry.
- Role graduates from a free-form label (ADR-0015) to a first-class entity; ADR-0015's
  `role` field is how a session points at it.
- ADR-0018's per-role directories are now DEFINED BY the registry (the role's `home
  directory`), not ad hoc.
- The cluster map, `ccs resume`, spawning, arming, and materialization all read one
  registry. This is the unification that motivated killing the plugin.
