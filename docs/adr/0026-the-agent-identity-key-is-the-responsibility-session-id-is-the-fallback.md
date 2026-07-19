# The agent identity key is the RESPONSIBILITY — [cluster] · role · [work-unit]; session id is the fallback

The keystone that a design review found missing. ADR-0024 made "agent identity" the
primary entity and ADR-0023/0025 hang durable state (inbox, result, judgment) off "the
identity" — but no ADR said what the identity's KEY is. The only concrete handle was
the session id. A resume KEEPS the same session id (it replays `claude --resume <id>`),
so resume alone is safe — but an identity is not welded to one session for life: a
closed agent can be re-embodied by a DIFFERENT session, and a role/work-unit can be
handed to a fresh session. If state keyed on the session id, that handoff would silently
lose the mailbox and memory — the exact bug-class ADR-0014 exists to kill, one level up.
Decided with Milad 2026-07-09.

## Decision — the identity key already exists; it is the RESPONSIBILITY

The durable agent-identity key is the RESPONSIBILITY — the same thing ADR-0023 keys
inboxes on. It is NOT the session id.

The general form is a namespaced tuple: `[cluster] · role · [work-unit]` — cluster if
the role belongs to one, role always, work-unit if it's fleet. Each part is included
only when it applies, so it degrades cleanly:

- **Core role in a cluster** (singleton) → `cluster · role`, e.g. `pr-watch · control`.
  The cluster prefix means two clusters can each have a `control` without colliding.
- **Fleet** (many workers sharing a role) → `cluster · role · work-unit`, e.g.
  `pr-watch · pr-agent · heroku_dashboard-12113`. Stable for the life of that work.
- **Role with no cluster** (cluster is optional, ADR-0022) → just `role` (+ work-unit
  if fleet). No cluster part.
- **Unassigned session** (started with no role yet — a manual `claude`, a foreign
  session) → the SESSION ID is its identity, as a FALLBACK, until it is given a role.
  Then it graduates to a responsibility key (the ADR-0017 SessionStart hook is where an
  unregistered session gets asked its role/cluster and thereby its identity).

So the identity key is derived from cluster + role (+ work-unit for fleet), all of which
the catalogue already stores — NOT from the session id.

## Why this closes the hole (continuity by construction)

Durable state (inbox, result, judgment — ADR-0023/0025) keys on the RESPONSIBILITY.
Whether the identity is re-embodied by a resume (same session id) or handed to a NEW
session, the cluster + role + work-unit are UNCHANGED, so the responsibility key is
unchanged, so whatever session holds the identity reads the SAME inbox and the SAME
state. Continuity is automatic — nothing has to "carry state forward across a session
handoff," because state was never keyed on the session id in the first place.

The session id's remaining jobs shrink to:
- the RESUME HANDLE for the current embodiment (`claude --resume <id>`), per ADR-0014;
- the FALLBACK identity for a session that has no role/responsibility yet.

## The two handles, cleanly separated

| concept | key | stable across a re-embodiment? |
|---|---|---|
| agent identity (what inbox/state hang off) | responsibility: `[cluster]·role·[work-unit]` | YES — derived from cluster/role/work, so it survives even a handoff to a new session |
| current embodiment (which process to revive) | session id / resume_id | resume keeps it; a fresh session assigned the identity gets a different one |

This is the same separation ADR-0014 drew between identity and the cmux ref, applied to
the session id itself: the session id is a handle to an embodiment, not the durable
name of the agent.

## Consequences

- ADR-0023's "inbox keyed by responsibility" is generalized: responsibility IS the
  agent identity key, so ALL identity-scoped state (inbox, result, judgment) keys on it.
- ADR-0024's "identity is primary, no key yet" is completed: the key is the
  responsibility.
- Resume "loses nothing" is now backed: state survives a session-id swap because it
  never depended on the session id.
- Edge cases to handle in build: a work-unit retired then re-taken later resolves to the
  same responsibility key (same mailbox — arguably correct; note it). An unassigned
  session's fallback (session-id-keyed) state does NOT auto-migrate when it later gets a
  role — the SessionStart-hook identity assignment must move/adopt it, or accept that
  pre-identity state stays under the session-id key. Specify at build time.
- Multi-session-per-identity (ADR-0024's future): two live sessions sharing one
  responsibility would share one inbox — a real concurrency case to solve THEN (drain
  coordination), out of scope now, but the key model already supports one mailbox per
  identity regardless of how many embodiments it has.
