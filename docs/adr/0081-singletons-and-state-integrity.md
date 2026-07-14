# ADR-0081: Singletons + state integrity (D4)

Status: **active** (adopted 2026-07-14, "D4" ratified decision from full-system review)

## Context

The 2026-07-14 full-system review flagged four P1 defects in the state-mutation and
liveness plane:

- **B4 — control watchdog can report a dead control plane as healthy forever.** The
  ensure-control heartbeat treated `titled workspace exists AND board.json is fresh` as
  proof of liveness. But `board.json` is written by the independent launchd sense
  pipeline, so a wedged control loop keeps its workspace title while sense keeps the
  board fresh: the watchdog reported "alive + ticking" while the driver was dormant.
- **B5 — unlocked check-then-spawn: duplicate control planes.** The watchdog's
  detect-and-spawn had no lock. Two overlapping ensure-control invocations (launchd +
  manual, or clock skew) could both observe "no control" and both spawn.
- **B7 — sessions.json unlocked read-modify-write; multi-step partial states.** The
  `registry_set` helper rewrites the whole registry per field. Concurrent worker
  registrations clobber each other; a crash between the three fields written during
  registration (sessionId, cmuxWorkspace, cwd) left a valid-looking but incomplete
  record.
- **B8 — stale sense-lock recovery can delete a newer run's active lock.** The
  sense-run lockdir had no owner token. A stale takeover then the original owner's exit
  trap unlinking the same path let a third invocation start concurrently with the
  second.
- **B13 — worker stop-hook events: non-atomic write, one mutable filename per key.**
  Event JSON was printf'd directly to the final path; multiple turns before a drain
  overwrote each other; a crash mid-write left malformed JSON.

## Decision

Four independent fixes with the same underlying principle: **every state boundary that
can race, race-safe it with a mechanism, not a convention.**

1. **Control heartbeat as proof-of-liveness (B4).** New tool: `control_heartbeat.py`
   with `beat / check / status`. The control tick writes the heartbeat at the top of
   every fire (via the `pr-watch-control` command block). The heartbeat file's freshness
   is the SoT for "is the loop running?" — board.json is now irrelevant to this test.
2. **Atomic spawn claim (B5).** `ensure-control.sh` acquires a mkdir-lockdir before
   spawning; a second invocation finding the claim exits cleanly. Stale claims (>5min)
   are stolen so a crashed watchdog can't wedge the recovery path.
3. **Locked + owner-tokened registry writes (B7).** `registry_set` (single-field) and
   new `registry_upsert_batch` (multi-field) acquire a `.sessions.json.lockdir` and
   write via temp+rename. Session registration now writes all three fields in ONE atomic
   pass — no more partial records.
4. **Owner-token locks for sense-run + pill-sweeper (B8).** Each run writes a unique
   token file inside the lockdir. The exit trap only cleans up when the token still
   matches — a stale takeover then original-exit sequence can't unlink the current
   owner's lock.
5. **Atomic + unique-per-turn worker events (B13).** `worker-stop-hook.sh` writes each
   event to `events/<key>-<epoch>-<pid>.json` via temp+rename. `drain_events.py` already
   globs `*.json` so no changes needed on the drain side.

## Consequences

**What this fixes:**
- The B4 wedged-driver false-positive class is dead: only the control loop's own tick
  writes the heartbeat, so a dormant loop cannot fake liveness through the sense
  pipeline.
- Duplicate control planes from clock skew are impossible under the atomic claim.
- sessions.json concurrent writes are serialized; partial-registration crashes leave
  either the full row or nothing.
- The lockdir stale-takeover race that could serialize three concurrent runs into two
  is gone.
- Stop-hook events survive crashes and no longer overwrite each other.

**What this defers (not this ADR):**
- Auto-kill / atomic recovery of a wedged control pane. The watchdog still logs and
  waits for an operator on a wedged pane rather than issuing `ccs resume control
  --cluster pr-watch`. Recovery via `ccs resume` is a follow-up.
- `migrate_keys.py` still does a multi-file mutation without a compensating log. That's
  a rare admin op; addressing it isn't in scope here.
- The unlocked single-row board recompose (B9) is retired by D8's event-coalesced
  recompose (later step), not this ADR.

## Verification

- Live: `control_heartbeat.py beat` + `check` + `status` all round-trip.
- `ensure-control.sh` with a fresh heartbeat logs "control heartbeat fresh — no-op".
- `bash -n` passes on every touched shell script.
- The 610-test suite is untouched (D4 changes are shell + Python; no TS diff).

## Related

- Full-system review 2026-07-14, decision D4.
- ADR-0002/0012 (control anti-dormancy) — this ADR fixes the actual anti-dormancy proof.
- ADR-0033 (inbox move-on-drain) — same discipline extended to worker-stop events.
