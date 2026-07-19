# The inbox is keyed by RESPONSIBILITY (role for core, work-unit for fleet); it is a durable, sender-decoupled message stream

Formalizes the session ↔ messaging relationship. Follows ADR-0022 (role first-class,
core/fleet split) and ADR-0002 O2 (the durable file-inbox already built). Decided with
Milad 2026-07-09.

## What the inbox is (and is not)

The inbox is the ONE inbound message stream for a session: everything sent TO it by
anyone else — the control plane relaying a task, the Slack scout routing a relevant
Slack message, a future GitHub scout routing PR/CI updates, another session passing
info. Requirements Milad stated:
- CHRONOLOGICAL, with new-vs-seen detection (process each new item into context once).
- Works while the session is CLOSED — a sender must not care whether the recipient is
  running. It is a durable file drop, drained when the session next runs.
- MANY senders, ONE ordered stream per recipient.

NOT the inbox: a session's OWN output/memory (pr-<key>.result.json / judgment.json —
what it concluded), and system-wide sensed state (board/gate/pending). Those are
separate per-session and per-system state. Inbox = "what others tell me"; result =
"what I concluded." Keep distinct.

## The key: RESPONSIBILITY, not session id, not raw role

Earlier candidates were both wrong:
- **Session id** — breaks across resume (a resumed session may be a new process) and
  doesn't express "this PR's mailbox."
- **Raw role** — collapses all workers together (every worker is role `pr-agent`, so
  one `pr-agent` inbox would merge #12113's and #12120's mail).

The right key is the RESPONSIBILITY a session embodies — the namespaced tuple
`[cluster] · role · [work-unit]` (ADR-0026), which is the ADR-0009 core/fleet split
made concrete:
- **CORE roles are singletons** (one control, one eval, one concierge, one scout per
  cluster). Their responsibility is cluster + role → inbox keyed by
  `inbox/pr-watch/control/`, `inbox/pr-watch/scout/`, etc. The cluster prefix keeps two
  clusters' `control` inboxes distinct.
- **FLEET (pr-agent) shares a role across many PRs.** Its responsibility adds the
  work-unit it owns → `inbox/pr-watch/pr-agent/heroku_dashboard-12113/`. (The CURRENT
  O2 implementation keys `inbox/<key>/` by the flattened PR key — close, but the
  cluster + role prefix is the corrected form; migration is a re-path.)
- A role WITHOUT a cluster drops the cluster segment (cluster is optional, ADR-0022).

A mailbox therefore survives close/resume: it is tied to the enduring responsibility
(cluster + role + work-unit), not to the ephemeral session/process.

## Ownership and location — a ccs-level primitive

Because the key is a universal notion (a session's responsibility) and Milad wants it
to "scale past pr-watch," the inbox is a CCS-OWNED primitive, not a pr-watch feature:
- Lives under the ccs data dir (e.g. `~/.claude-sessions/inbox/<responsibility-key>/`),
  not `~/.claude/pr-watch-2/`.
- ccs exposes the verbs: `ccs inbox deliver <key> --from <sender>`, `ccs inbox drain
  <key>`, `ccs inbox pending <key>`. Any system (pr-watch, event-watch, future) uses
  the same mechanism. pr-watch's `lib/inbox.py` is replaced by calls to ccs (or ccs
  absorbs that code).
- Delivery semantics are unchanged from O2: atomic write, drain = move-to-`processed/`
  (exactly-once, idempotent), timestamped filenames (chronological + new-vs-seen).

## How a session finds its own inbox

A session knows its identity (session id, from the SessionStart payload / env). It
resolves its RESPONSIBILITY key from ccs: a core session → its role; a worker → its
work-unit (pr / gus_work). Then drains `ccs inbox drain <that key>`. The ADR-0017
SessionStart hook can inject this at start so draining is the first thing a session
does. Single lookup, via the catalogue.

## Consequences

- Senders address a recipient by its responsibility key and never need to know if it
  is alive, where it runs, or its session id. Full time + location decoupling.
- Fleet inboxes are already correct (work-unit keyed); only CORE inboxes move from the
  legacy key form to role-keyed.
- The Slack scout (O7) and any future GitHub scout are just additional SENDERS to the
  same inbox — no new plumbing, they write by the recipient's responsibility key.
- Inbox joins ccs as a generic session-messaging primitive, decoupled from where a
  session's transcript lives (ADR-0014 cwd) and where it runs (ADR-0018 role dir). The
  three locations — identity, run-dir, mailbox — are independent, addressed three ways.
- Open: whether other inbound context types (beyond messages) ever need the same
  stream. For now the inbox is the single inbound message stream; result/judgment stay
  the session's own output.
