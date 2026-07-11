# A fresh embodiment rehydrates from its predecessors + full state — a new session never starts cold

Makes explicit what "the identity is durable, the session is a vessel" (ADR-0024) means at
the moment a NEW session takes over an identity. A same-id resume keeps the transcript, so
context is intact automatically. But when the identity is embodied by a DIFFERENT session
(the case ADR-0026/0030 exist for — a fresh session assigned the responsibility), that new
session has an empty transcript. It must not start cold. Decided with Milad 2026-07-09.

## Decision — bootstrap the new embodiment from everything the identity holds

On taking over an identity, a fresh session rehydrates its context from three durable
sources, all keyed on the responsibility (ADR-0026/0030) so they're found automatically:

1. **Predecessor sessions' transcripts.** The identity's prior embodiments left transcripts
   (ccs knows the identity's session history via the catalogue). The new session reviews
   them — what past embodiments did, tried, and concluded — instead of rediscovering it.
   This is the identity's episodic memory across bodies.
2. **Full inbox + state history.** Its `result` / `judgment` (what it concluded, ADR-0025)
   and its inbox — both the pending mail and the `processed/` history (ADR-0033) — so it
   knows what it was told and what it already handled.
3. **Cluster state.** The shared picture (board, gate, dispositions — ADR-0025/0031) for the
   operational context around this work-unit.

The result: a new embodiment picks up with the same working knowledge the previous one had,
even though it's a different session with a different id. Continuity is of the IDENTITY, not
of any one session.

## Why this belongs in the model

- It's the payoff of keying state on the responsibility (ADR-0026/0030): the reason that
  key exists is so a new body can find "everything this identity knows." This ADR names the
  bootstrap that actually consumes it.
- It generalizes the worker's existing "drain your inbox on start" (ADR-0033) into a fuller
  rehydration: inbox is one of three sources, alongside predecessor transcripts and cluster
  state.
- It's what makes a warm agent survivable across a full session swap, not just a resume —
  the "warm, long-lived agent" promise (the doc's why-not-subagents argument) holds even
  when the underlying session is replaced.

## Build notes / bounds

- **Cost/scope control.** Reviewing every predecessor transcript in full can be large. The
  bootstrap should prefer the identity's own distilled memory (`result`/`judgment`) as the
  primary source and reach into raw predecessor transcripts as needed, rather than replaying
  everything verbatim. Exact strategy (summarize-on-Stop vs. read-on-demand) is a build
  decision; the invariant is "a fresh embodiment has access to its predecessors' knowledge."
- **Mechanism.** ccs exposes the identity's session history + its state paths; the rehydrate
  step (a SessionStart hook / the role's arming) pulls them. Consistent with ADR-0029 (the
  role owns its own upkeep) — rehydration is part of a role's "on start" checklist item.
- **Same-id resume is the easy case** — the transcript is already present, so rehydration is
  a no-op beyond the normal inbox drain. This ADR's work is specifically the new-session
  takeover.

## Consequences

- The role-definition checklist (ADR-0029) gains "on a fresh embodiment, rehydrate from
  predecessors + state + cluster state," not just "drain inbox."
- Reinforces ADR-0024/0026/0030: the durable identity carries memory across bodies; this is
  how a body reads it.
- Pairs with ADR-0035: rehydration is best-effort + fail-open — if a source is unreachable,
  the session still starts (degraded), it just knows less until it can read the rest.
