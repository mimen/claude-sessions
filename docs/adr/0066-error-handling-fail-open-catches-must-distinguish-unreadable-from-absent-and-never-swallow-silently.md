# Error handling: fail-open catches must distinguish "unreadable" from "absent" and never swallow silently

Decided 2026-07-11 from the dead-code/error-handling audit (67+ silent catch blocks). A confident cleanup —
the direction is forced by the fail-closed principle already established for liveness (ADR-0054) and the
CI-2 invariant; this generalizes it to the rest of the codebase. Not debatable in direction; the work is
classification + applying one pattern.

## The problem

The audit found 67+ `catch {}` blocks. Most are fine (best-effort tab paint, streaming transcript parse,
best-effort inference). But several **fail open where they should fail closed** — they turn an I/O error
into a "there's nothing here" answer, which silently degrades or, worse, unblocks a dangerous action:

- `resume/locate.ts:49,78` — a disk error reading the storage folder returns `{kind:"absent"}` / null →
  "no session here," so resume does the wrong thing on a *transient read failure* vs a real absence.
- `roles/sync-roles.ts:79-80` — an `lstat` permission error is treated as "file doesn't exist."
- `state/store.ts:66,72,109` — a corrupt/unreadable state doc silently returns defaults → in-flight state
  vanishes with no signal.
- `hooks/register-command.ts:23,75,79` — hook-registration failures are swallowed → a session starts with
  broken hooks and nothing says so.

These share one bug: **"I couldn't read it" is collapsed into "it isn't there."** The two must be
distinguished, because they demand opposite responses — absence is normal (proceed), unreadable is an error
(fail closed / surface it). This is the exact defect class ADR-0054 fixed for liveness (`readable` flag);
it just wasn't applied elsewhere.

## Decision

1. **Distinguish unreadable from absent everywhere a catch turns I/O into a value.** Missing file / no row
   = absent (a legitimate empty result, proceed). Read error / parse error / permission error = unreadable
   (a failure). The two return distinguishable results; callers that *spawn or mutate* on the result must
   fail closed on unreadable (the CI-2 / ADR-0054 rule), not treat it as empty.

2. **No silent swallow.** Every catch that discards an error logs it (stderr / a `CCS_DEBUG` channel) with
   context, even when it then degrades gracefully. A dropped error must be *visible*, not invisible.
   Introduce a small helper (`tryOrLog(fn, fallback, ctx)`) so "fail-open but logged" is one obvious idiom
   and "fail-open and silent" stops being the path of least resistance.

3. **Classify all 67, don't blanket-change them.** Three buckets, each with a fixed treatment:
   - **acceptable fail-open** (inference best-effort, streaming parse, best-effort cosmetic paint) → wrap in
     `tryOrLog` so it's logged; behavior unchanged.
   - **log-needed** (most I/O) → distinguish absent vs unreadable; log the unreadable case.
   - **must-fail-closed** (anything feeding a spawn/mutate decision: `locate.ts`, `register-command.ts`,
     `store.ts` when the doc gates behavior) → surface the error / abort, never proceed on a guess.

4. **`register-command.ts` specifically fails loud on hook-registration errors** — a session with broken
   hooks is a correctness problem, not a cosmetic one; it must signal rather than boot silently degraded.

## Why now, why not debatable

- The principle is already decided (ADR-0054 fail-closed, CI-2). This is applying it consistently, not
  choosing a new stance.
- The `absent vs unreadable` distinction is the same shape as the liveness `readable` flag that already
  shipped — proven pattern, just under-applied.
- The one judgment left is per-site classification (which bucket), and the audit already did that mapping;
  implementation follows it.

## Consequences

- Add `tryOrLog` (or equivalent) to a shared util; sweep the 67 sites into the three buckets.
- `locate.ts` / `store.ts` gain an absent-vs-unreadable distinction in their return types (or an error
  channel); callers that spawn/mutate honor it (fail closed).
- `register-command.ts` surfaces hook-registration failures.
- Consider adopting the existing `Result<T>` at these boundaries (it's used by 4 modules already) rather
  than `T | null`, so the caller is type-forced to handle the unreadable case — optional, but the audit
  flagged the inconsistency; pick one and document it.
- Pairs with the CI-2 invariant (fail-closed everywhere it spawns) and closes the "silent degradation"
  weakness the audit rated the top error-handling risk.
