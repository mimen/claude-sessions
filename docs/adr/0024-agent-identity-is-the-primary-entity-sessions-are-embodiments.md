# The agent identity is the primary entity; sessions, terminals, processes are embodiments

Sits ABOVE ADR-0014. That ADR said "identity = the Claude session id." This ADR
reframes what ccs is fundamentally managing: not sessions, but AGENT IDENTITIES.
Decided with Milad 2026-07-09.

## The reframe

ccs manages AGENT IDENTITIES. An agent identity is the durable, primary entity —
"the control agent," "the #12113 worker." It persists whether or not it is currently
running.

A session, a terminal tab, a running process are DOWNSTREAM embodiments — how an
identity is currently instantiated. They come and go; the identity does not.

- An identity HAS a current session (the Claude session id that embodies it now).
- Potentially MULTIPLE sessions, and eventually across MULTIPLE SUBSTRATES (not just
  Claude Code). The design should not assume one-session-per-identity forever.
- Resume/fork can swap the underlying session id while the agent identity stays
  constant. Role, inbox, resume_command, lifecycle all hang off the AGENT, not off any
  one session.

## What ccs is, restated

ccs is the mechanism by which we manage and orchestrate agent identities — and
crucially, it exists to make the ERGONOMICS of running many agents compatible with
human reality:
- limited compute — you cannot keep every agent's process open at once;
- limited attention — you cannot hold dozens of agent tabs in your head;
- the mental overhead of tab/session sprawl.
So ccs lets an identity be CLOSED, RESUMED, and REACHED on demand without losing
anything. That is the point of the whole system, not incidental bookkeeping.

## Relationship to ADR-0014

ADR-0014 is not wrong; it is narrowed. Its "session id = identity" becomes: the
Claude session id addresses the CURRENT EMBODIMENT of an agent identity. The durable
name is the agent; the session id is how you reach the incarnation that exists right
now. When an agent has one session (the common case today), they look 1:1 — but the
model is agent-first so it extends to multiple/again-resumed/multi-substrate
embodiments without rework.

## Consequences (kept light, per Milad — this is vision, not new mechanism)

- No new mechanism is mandated by this ADR today. The existing decisions (0014–0023)
  stand; this establishes the LANGUAGE and the layer they sit under: role/inbox/arming
  attach to the agent, sessions are its embodiments.
- Practically, near-term, an agent identity and its current session id are effectively
  1:1, so existing catalogue rows keyed by session id are fine as the current-embodiment
  pointer. The multi-session / multi-substrate expansion is a FUTURE direction this
  framing leaves room for, not a thing to build now.
- Vocabulary: prefer "agent identity" for the durable entity and "session / embodiment"
  for the running instance in docs going forward.
