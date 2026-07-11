# One responsibility = one live embodiment — best-effort detection + atomic drain, not a lease

ADR-0024 allows multiple sessions per identity as a future possibility; ADR-0026
explicitly punted the drain-coordination that would require. Both design reviews flagged
this as the sharpest near-term risk: two live sessions sharing one responsibility share
one inbox/result/judgment and can double-drain, double-act, or overwrite each other's
state. This ADR pins the near-term invariant. Decided with Milad 2026-07-09.

## The invariant

**A responsibility has at most one LIVE embodiment at a time.** Multi-session-per-identity
stays vocabulary only (ADR-0024) — we do not build toward it until inbox drains and state
writes are solid. For every cluster ccs runs today, this holds by how sessions are born.

## How it's guaranteed (in order of strength)

1. **By construction, for the fleet.** Fleet workers are ALWAYS ccs-spawned
   (`spawn-agent.sh` → `ccs new-session`). ccs never spawns a second embodiment of a
   responsibility it already tracks as live. This covers the overwhelming majority case.
2. **Best-effort liveness detection before resume.** `resume-cluster` skips
   already-open members. "Open" is resolved by a detection chain, strongest first:
   - **recorded cmux ref** (ADR-0014) — exact, for anything ccs spawned;
   - **cwd** — for a session ccs didn't spawn but whose worktree/role-dir it knows;
   - **tab title** — last-resort fuzzy match (what `open-state.ts` does today, with an
     ambiguity guard).
   The title fallback is deliberately last: titles are mutable (ccs renames tabs) and can
   collide, so it's used only to avoid the worse outcome (spawning a duplicate), never as
   the primary handle. Milad 2026-07-09: title-matching is acceptable here — better than
   leaving it ambiguous — as long as it isn't the first resort.
3. **Atomic drain as the real safety net** (ADR-0033). Detection is best-effort, so it
   CAN miss — the case that matters is a human manually resuming a worker outside ccs (a
   "foreign pane," which cmux's listing can't expose the session id for, ADR-0021). The
   guarantee against that isn't perfect detection; it's that the inbox drain is atomic and
   idempotent, so even if two embodiments briefly coexist, no message is double-processed
   and no state is corrupted. Detection minimizes duplicates; atomic drain makes a missed
   detection harmless.

## Why not a lease/lock in v1

A lease (ccs grants exactly one embodiment the right to a responsibility, refusing a
second claimant) is the textbook answer and is the right escalation IF a real
multi-embodiment need appears. We skip it now because:

- the fleet is ccs-spawned, so construction already gives single-embodiment for the case
  that actually occurs;
- the only breach is a human manual resume, which is rare and non-adversarial;
- move-on-drain is atomically exclusive (ADR-0033) — the move succeeds for exactly one
  drainer per message — so it already neutralizes the harmful consequence of a breach
  (no double-delivery), and we need it anyway;
- a lease adds a liveness/expiry/steal protocol (what happens when the holder crashes
  without releasing?) that is real machinery to get right, for a case the above already
  covers.

So: **construction + best-effort detection + atomic drain now; lease deferred** until a
genuine multi-embodiment requirement (ADR-0024's future) makes it necessary.

## Consequences

- ADR-0026's "multi-session sharing one inbox is a future concurrency case" is answered
  for the near term: we forbid it in practice (one live embodiment) rather than solve
  concurrent drain.
- The detection chain (surface UUID → session id from the cmux state file → cwd → title,
  per the ADR-0040 audit) is specified once and every liveness caller uses it (composes with
  the all-windows `tree --all` sweep, ADR-0016). Identity keys on the surface UUID; the
  session-id read makes title a distant last resort, not a real dependency.
- Hard dependency on ADR-0033: the drain MUST be atomic + idempotent for this ADR's safety
  net to hold. If drain semantics change, revisit this.
- Escalation path is clear and cheap to add later: if multi-embodiment becomes real,
  introduce a lease keyed on the responsibility; the detection chain becomes the lease's
  liveness probe, and atomic drain stays as defense in depth.
