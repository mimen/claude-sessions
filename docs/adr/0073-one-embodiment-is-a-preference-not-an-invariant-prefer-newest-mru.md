# One embodiment is a preference, not an invariant — prefer the newest (MRU), warn on duplicates

Refines ADR-0032 (one responsibility, one embodiment) and retires ADR-0072 (the atomic
claim lock). Decided with Milad 2026-07-12.

## What changed since ADR-0032

ADR-0032 already chose the right posture for the dangerous case — *best-effort detection +
atomic drain, not a lease*. But it framed single-embodiment as an **invariant** ("we forbid
it in practice"), and that framing hardened into a `new-session` **refusal**: the spawn
contract (ADR-0047, `spawnContractError`) rejects a worker spawn if any live session already
owns the work-unit. Milad's call, on review: that rigidity buys little and costs ergonomics.
The two failure modes it lumps together are not equally dangerous, and only one deserves a
hard guard.

## The two modes are different

- **Mode A — the SAME session embodied twice** (two `claude --resume <sameId>` on one
  transcript file). This IS dangerous: interleaved/corrupted transcript, double-fired hooks,
  racing tool calls. Prevent it.
- **Mode B — two DIFFERENT sessions of the same responsibility** (distinct sessionIds, same
  role + work-unit). The shared surface is the identity's inbox and its state docs. The worst
  case here is **confusion and waste, not corruption**: the inbox is move-on-drain (a message
  goes to exactly one drainer, ADR-0033), and state writes are atomic temp+rename
  (last-writer-wins per field, ADR-0031). So two twins can duplicate work, and a steer can
  land with the "wrong" twin, but nothing is corrupted and no message is double-processed.

## Decision

1. **Mode A stays best-effort** (unchanged from ADR-0032): before opening a session, check
   the cmux liveness snapshot (hook store + tree) for that exact sessionId/resumeId and skip
   if already live. A lock is NOT added — the small TOCTOU window is acceptable for a
   non-adversarial, single-operator system, and a genuine same-session double-open is already
   rare (ccs spawns with `--session-id`; resume checks liveness first).

2. **Mode B is a PREFERENCE, not an invariant.** ccs no longer *refuses* a second embodiment
   of a work-unit. `spawnContractError` drops the one-embodiment check (the correct-worktree
   check stays — that's an unrelated born-wrong guard). A second embodiment is allowed to
   exist; it is simply discouraged and made self-healing by (3) and (4).

3. **Prefer the newest (MRU) when resolving an identity to a session.** The "which session
   should I open?" resolver — the selector's role/cluster lookups and the resume paths — MUST
   return the **most-recently-used** session (`updated_at DESC`) so resume deterministically
   reaches for the freshest embodiment of an identity, not an arbitrary one. This is the
   mechanism that makes tolerating Mode B safe: a duplicate becomes a transient state that the
   next resume collapses toward the active session, instead of a permanent fork.

4. **Warn on live duplicates; never close a pane.** When resume opens the MRU session and
   other live siblings of the same identity exist, ccs SURFACES that ("N other live sessions
   share this identity") for the operator/control to resolve. ccs does **not** proactively
   close a running cmux pane — killing a live pane is exactly the strict enforcement we are
   moving away from, and the atomic-drain safety net means a lingering twin is harmless, not
   urgent. The cluster-resume supersede-dedup (mark older *dead* siblings so they aren't
   re-resumed) is unchanged; it operates on non-live rows and needs no pane action.

## Consequences

- **ADR-0072 is retired (won't-build).** It closed the spawn TOCTOU with an atomic work-unit
  claim lock — an escalation ADR-0032 had deferred "until a genuine multi-embodiment need
  appears." That need was resolved the other way: multi-embodiment is tolerable, so the lock
  is unnecessary machinery (liveness/expiry/steal protocol) for a case we no longer guard.
- **`spawnContractError` loses the one-embodiment branch** (`liveWorkUnits` becomes unused by
  the contract). A worker spawn is born-correct on worktree/branch grounds only.
- **The identity→session resolvers gain a deterministic MRU order** (`sessionsForRole`,
  `sessionsForCluster`, and the selector that consumes them). Previously unordered, so "which
  session opens" was arbitrary — the latent gap this ADR closes.
- **Atomic drain (ADR-0033) remains load-bearing** and is now explicitly the primary safety
  net for Mode B, not merely a backstop. If drain semantics ever change, revisit this.
- **ADR-0024's multi-session-per-identity vocabulary is now partially realized**: multiple
  embodiments are a real, tolerated runtime state (MRU-resolved), not just future vocabulary.
- Net simplification for ADR-0057 (work-unit entity): the entity needs a stable id for
  joining + MRU selection, but NOT a strict uniqueness/one-live guarantee.
