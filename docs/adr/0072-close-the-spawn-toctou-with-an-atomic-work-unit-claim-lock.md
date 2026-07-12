# Close the spawn TOCTOU with an atomic work-unit claim (a lock), not just a re-check

> **RETIRED / WON'T BUILD (superseded by ADR-0073, 2026-07-12).** This ADR closed a TOCTOU race in
> the one-embodiment REFUSAL. ADR-0073 removed that refusal entirely: a second embodiment of a
> work-unit is now tolerated (resume prefers the most-recently-used session and warns; the atomic
> inbox drain keeps a transient twin harmless), so there is no refusal left to race against and no
> lock to add. The lock's liveness/expiry/steal protocol is machinery for a guarantee we no longer
> make. Kept for the design trail only.

Decided with Milad 2026-07-11. The last genuine design decision in the production-readiness document: the
one-embodiment check has a Time-Of-Check-to-Time-Of-Use race that ADR-0057 (stable work-unit id) and
ADR-0054 (fail-closed liveness) don't close. Uses the lock-as-a-meta-field primitive from ADR-0064.

## The bug (D1 / U9 / CI-3)

`ccs new-session` enforces the **one-embodiment rule** (at most one live **session** per **work-unit**) by:
1. **check** (`new-session.ts:327`): read the live work-units, confirm this one isn't claimed;
2. …mint id, write row, resolve cwd…;
3. **use** (`~:288`): spawn the cmux **workspace**.

There is **no atomic step between the check and the spawn**. Two concurrent spawns for the same work-unit
both run (1), both see "not live," both pass, both reach (3) → **two live workers on one PR** (the
12120/12121 duplicate-fleet incident). The check was true at check-time and stale by use-time — a classic
TOCTOU. ADR-0057 stabilized *what the key is*; it did not serialize *check-then-spawn*. ADR-0054 handles
*unreadable* liveness, a different failure.

Trigger: genuinely concurrent spawns — a CI pipeline launching workers for one PR in parallel, or a fast
double-invocation. Rare manually, real under automation (where production load comes from).

## Decision

**Atomically CLAIM the work-unit before spawning, using the single-holder lock from ADR-0064. A claim that
loses the race refuses to spawn.** Not an optimistic re-check (which only shrinks the window) — a real
mutual-exclusion claim (no window).

Flow:
1. Resolve the target **work-unit id** (ADR-0057 find-or-create).
2. **Atomically acquire a single-holder claim** on that id — the ADR-0064 lock primitive
   (`type = "lock"`, single-holder guarantee) keyed on the work-unit id, written via the atomic
   temp+rename / `mergeFields` single-writer path (ADR-0031). Acquisition is the check: if the claim is
   already held by a *live* session, the current spawn **refuses** (fail closed — the CI-3 one-embodiment
   invariant, now race-free).
3. Only the holder proceeds to write the row + spawn.
4. The claim is tied to liveness: it's released when the session ends, and a claim held by a **dead**
   session (per the **bridge**) is reclaimable — so a crashed spawn never wedges the work-unit forever
   (the claim is advisory over liveness, not a permanent gate). Stale-claim reclaim reuses the
   supersede-dedup liveness check (ADR-0057/S22), so "held by a dead session" = free.

The acquire-or-refuse replaces the current read-set-then-check: the *acquisition itself* is the
one-embodiment enforcement, so there is no check→use gap.

## Why the lock, not the optimistic re-check

- **It's a guarantee, not a smaller window.** Optimistic re-check (read again just before spawn) shrinks the
  race but never eliminates it — two spawns can still interleave inside the shrunk window. A single-holder
  claim is mutual exclusion: exactly one wins, always.
- **The mechanism already exists.** ADR-0064 built locks-as-a-declared-meta-field with a single-holder
  guarantee and atomic writes; the work-unit claim is just that primitive keyed on the work-unit id. No new
  concurrency machinery — nearly free.
- **It composes with what's already decided:** the claim keys on the ADR-0057 stable id; reclaim reuses the
  ADR-0054/S22 liveness check to free dead-held claims; the atomic write is the ADR-0031 single-writer path.

## Consequences

- `new-session` (post ADR-0065 move, likely `resume/new-session.ts` or `src/spawn/`) acquires the work-unit
  claim before writing/spawning; refuses on a live-held claim with a clear error ("work-unit <id> is claimed
  by a live session <sid>").
- The claim is a work-unit meta field (ADR-0064 lock type), released on session end, reclaimable when the
  holder is dead-per-the-bridge.
- Depends on: ADR-0057 (work-unit id), ADR-0064 (lock primitive), ADR-0031 (atomic single-writer). Sequence
  after those.
- Closes CI-3 (no duplicate embodiment) at the spawn path race-free; the resume path already dedups via
  supersede (S22). Integration test: two concurrent spawns for one work-unit → exactly one spawns, the other
  refuses.
- The completeness cross-check (task #9, runbook-only) remains the *separate* mitigation for the different
  Case-2 gap (sessions launched outside the shim); this ADR is only about the spawn-vs-spawn race.
