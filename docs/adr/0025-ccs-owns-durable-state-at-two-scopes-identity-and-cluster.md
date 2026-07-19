# ccs owns durable state at two scopes — identity/role state and cluster shared state

Generalizes ADR-0023 (the inbox moved to ccs) into a consistent rule for ALL durable
state. Follows ADR-0022 (roles/clusters first-class in ccs) and ADR-0024 (agent
identity is primary). Decided with Milad 2026-07-09.

> **Scope + bound (2026-07-09).** This "ccs owns all durable state, generally across
> clusters" ambition is deliberate, not premature: event-watch is a real, imminent second
> consumer (the model ports there right after pr-watch). It is SAFE only because it is
> bounded by a concrete storage contract — file-backed, cluster-scoped, versioned, atomic,
> single-writer-per-field — specified in **ADR-0031**. Read 0025 for WHAT ccs owns and why;
> read 0031 for the HOW that keeps "general store" from meaning "unspecified store."
> Identity-scoped state keys on the responsibility (ADR-0026/0030); GC/retention: completed
> state is retained, not thrown away.

## The inconsistency this resolves

ADR-0023 moved the inbox into ccs because it is durable per-identity state. But
`result.json` / `judgment.json` are ALSO durable per-identity state, and they were
left as loose files in pr-watch's private `~/.claude/pr-watch-2/` state dir. Milad
flagged: if the inbox belongs in ccs, so does any other durable state an identity must
manage. Leaving some in ccs and some in a system's folder is inconsistent.

## Decision

ccs is THE durable store. Beyond its catalogue (identities) and roles registry, ccs
holds durable state at TWO scopes:

1. **Identity/role state** — keyed by the agent IDENTITY (not the session; the durable
   identity per ADR-0024). Two kinds:
   - **inbox** — messages IN (what others tell it), ADR-0023.
   - **own output/memory** — what the identity concluded / its working state (today's
     `result.json` / `judgment.json`).
   Called "identity/role state" deliberately, NOT "session state": it belongs to the
   durable identity and survives across the sessions that embody it.

2. **Cluster shared state** — keyed by the CLUSTER. The operation's shared picture:
   `board` / `gate` / `pending` / `dispositions` / `slack_scout` / `control-wake`. A
   cluster's shared state also lives in ccs.

ccs owns LOCATION + DURABILITY at both scopes. The SYSTEM owns the SCHEMA/MEANING —
ccs stores pr-watch's `result.json` or `board.json` without parsing them (the way it
already stores freeform `notes`). So this is not ccs learning pr-watch's domain; it is
ccs providing scoped, durable, addressable storage that any system uses.

## What this means for pr-watch's state dir

The private `~/.claude/pr-watch-2/` state dir largely DISSOLVES into ccs:
- per-identity files (inbox, result, judgment) → ccs identity/role state, keyed by
  identity.
- cluster-wide files (board, gate, pending, dispositions, slack_scout, control-wake)
  → ccs cluster shared state, keyed by the pr-watch cluster.
pr-watch stops owning a private durable folder; it reads/writes its state THROUGH ccs
(e.g. `ccs state ...` verbs) at the right scope. Single-writer-per-field (ADR-0004)
still applies, now enforced at the ccs layer.

## Why this is the right boundary

- ccs = the durable substrate for identities, roles, clusters, and their state
  (location + durability + addressing).
- the system (pr-watch) = the MEANING of that state and the logic that acts on it.
Nothing durable is "loose in a system's folder" anymore. Everything is in ccs, scoped
by identity or by cluster, so a session can be closed/moved/re-embodied and all its
state is reachable by identity, and a cluster's picture is reachable by cluster —
regardless of where anything runs.

## Consequences

- Consistent with ADR-0023: the inbox was the first instance of "identity state in
  ccs"; this makes the whole category live there.
- ccs grows scoped state storage (identity-scoped + cluster-scoped), opaque to ccs
  (system owns schema). Likely `ccs state`-style verbs alongside `ccs inbox`.
- The three independent ADDRESSES (identity / run-location / mailbox, ADR-0014) are
  unchanged; this is about WHERE durable state lives (ccs, scoped), not how a running
  session is addressed.
- Open (deferred): exact storage shape (files under a ccs data dir vs a table), and
  which currently-system-wide files might themselves generalize to other clusters.
  Not blocking the boundary decision.

## Review caution (2026-07-09) — noted, decision stands

A design review flagged this ADR as generalizing early: "ccs is THE durable store for
any system, opaque, scales past pr-watch" is a lot of abstraction for a system with one
cluster and one real consumer today. The reviewer's minimal alternative: move only the
inbox to ccs now (it has a concrete must-survive-close reason, ADR-0023) and leave
result/judgment as files until a second cluster proves the need — i.e. generalize on
demonstrated need, not on symmetry.

Decision (Milad): KEEP the general model. The value here is the clean boundary — nothing
durable loose in a system's folder — and the consistency is the point, not a bonus. The
caution is recorded so the tradeoff is explicit: we are accepting some build-ahead-of-need
in exchange for one uniform durable-state story. Two mitigations reduce the risk: (1) the
CONCURRENCY/single-writer mechanism and storage shape must be pinned before building (the
review's fair point — see below), and (2) build order can still stage it (inbox first,
result/judgment after) even though the model is whole.

## Concurrency / single-writer once state is in ccs (review gap — must pin at build)

The review correctly noted that "single-writer-per-field still applies, now at the ccs
layer" was hand-waved. On disk, single-writer was implicit in who owned the file. Through
`ccs state` verbs with many concurrent workers + control + concierge, this needs a REAL
mechanism: per-field ownership + atomic write (temp-file + rename, as inbox/dispositions
already do), or CAS. The exactly-once inbox drain (ADR-0023) relies on atomic move-to-
`processed/`, so the storage substrate must guarantee that. This is correctness, not a
detail — specify the write/lock model before building 0025's `ccs state`.
