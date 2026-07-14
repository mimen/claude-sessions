# ADR-0082: Board recompose is serialized (D8)

Status: **active** (adopted 2026-07-14, "D8" ratified decision from full-system review)

## Context

Bug **B9** in the 2026-07-14 full-system review: `compose_board.py`'s single-identity
recompose (`--identity <key> --write`) does a read-prior + merge-one-row + atomic write,
without any lock. Atomic rename protects readers from torn files, not writers from
lost updates. An event-triggered single-row recompose (fired from
`recomposeForSession` after a `ccs stage`, `ccs meta-set`, or a `/prwatch:approve`
call) racing a scheduled whole-board compose could silently revert every OTHER row to
the pre-tick snapshot.

The review scored this "CONFIRMED (dormant)" — the callers exist and the race is real,
but no observed corruption yet. It's the class of bug that surfaces at exactly the
wrong time (a deployment tick, a demo).

## Decision

**Serialize every board.json read-modify-write behind a single owner-tokened lock.**

Concretely:

1. New `board_lock()` context manager in `compose_board.py`. mkdir-based lockdir at
   `~/.ccs/clusters/pr-watch/cluster/.board.json.lockdir` with an owner-token file.
   Waits up to 10s; steals genuinely stale claims (>30s) so a crashed compose can't
   permanently wedge the pipeline.
2. Both `--identity <key>` and `--session <sid>` (single-row) modes wrap the whole
   compose + emit + write in `board_lock()`. The read-prior happens inside the critical
   section, so a concurrent writer's changes are visible.
3. Whole-board mode wraps ONLY the write in the lock (compose is pure, no need to hold
   the lock during it). A single-identity write landing during a whole-board compose is
   lost, but that's acceptable: the composer reads the same sensor inputs as the single-
   identity path, so the whole-board write re-derives the identity's row from the same
   truth. The next scheduled tick converges either way.

## Consequences

**What this fixes:**
- The B9 lost-update class is dead. A concurrent single-identity + whole-board pair
  now serializes — the second writer sees the first's changes and preserves them.
- The interactive read-your-write path (`/prwatch:approve` → `recomposeForSession`)
  still returns synchronously; the caller blocks briefly on the lock, not indefinitely.

**What this defers:**
- The "event-coalesced" half of D8 (writes append identity-scoped changed markers; the
  composer batches; the coalescer runs once per scheduler tick) is NOT implemented
  here. The lock alone eliminates the race; the coalescer is a performance / batching
  optimization the current cadence doesn't need. If board recomposes ever get called
  faster than they complete (a real bug, not a race), revisit.

## Verification

- Live: single-identity mode + whole-board mode both round-trip and release the lock.
- The `.board.json.lockdir` directory is created and removed cleanly on both paths.
- No tests changed (all Python; the ccs Bun test suite is unaffected).

## Related

- Full-system review 2026-07-14, decision D8, bug B9.
- ADR-0077 (phase-first board / identity-keyed rows) — this ADR is the write-side
  hardening of the same contract.
- ADR-0081 (D4 singletons + state integrity) — same lock discipline, different file.
