# ADR-0084: Wedged control plane auto-recovery

Status: **active** (adopted 2026-07-14, follow-up to ADR-0081 D4)

## Context

ADR-0081 made wedge detection sound (control-owned heartbeat, not board.json), but the
recovery response stopped at logging. The behavior was:

- Fresh heartbeat → no-op.
- Stale heartbeat AND no workspace → spawn fresh (case-2 recovery).
- Stale heartbeat AND workspace present → log a warning, exit. **Human required to close
  the wedged pane before the next fire can recover.**

Rationale for deferring in ADR-0081: auto-killing a live Claude session had two feared
failure modes — killing during a real turn (loss of mid-turn state) and thrash if the
recovery itself wedges.

With the heartbeat mechanism now live, both fears become tractable:

- A "wedge" is only declared after `PR_WATCH_CONTROL_STALE_S` (default 40 min) — well past
  a normal turn.
- A single cooldown window prevents thrash: if the fresh recovery ALSO wedges within the
  cooldown, the watchdog reverts to log-only, letting the operator investigate.

## Decision

**`ensure-control.sh` auto-recovers a wedged control plane by closing the wedged workspace
and spawning fresh, under a cooldown that prevents recovery thrash.**

The wedge-detection branch (formerly "log only") now:

1. If `.wedged-recovery-last` timestamp is younger than `PR_WATCH_RECOVERY_COOLDOWN_S`
   (default 3600s), log-only. The fresh session also wedged; a re-spawn won't help.
2. Otherwise, acquire the atomic spawn claim (same claim used in case-2), find the wedged
   workspace's cmux ref, `cmux close-workspace` it, then spawn a fresh control loop.
3. Stamp `.wedged-recovery-last` with the current time. The next fire, if the fresh
   session ALSO wedges, falls into path 1 above.
4. If `cmux close-workspace` fails, log and exit without spawning — never leave a live
   twin plus a fresh spawn.
5. If the wedged workspace vanishes between the `titled` check and the `ref` lookup, fall
   through to case-2 (spawn fresh). The pane closed itself; nothing to recover.

## Consequences

**What this changes:**
- A wedged control loop is now self-healing within one watchdog tick + cooldown, not
  "until Milad closes the pane." The fleet's dormancy time drops from "human response
  latency" to "watchdog cadence + cooldown."
- The cooldown is asymmetric: recovery attempts are 1/hour; a healthy loop is never rate-
  limited (it just doesn't wedge).

**What this preserves:**
- The atomic spawn claim (ADR-0081 B5) still guards against two concurrent watchdog fires
  both recovering — only one wins the mkdir race.
- The "no auto-kill of a healthy live session" rule is still honored: a wedged pane is
  gone (heartbeat stale >40 min) before we close it.
- Fresh-workspace-spawn without a wedge (case-2, cold-boot) is unchanged.

**What this leaves for future work:**
- The stale-heartbeat threshold (2400s / 40 min) is a static config. A more sophisticated
  detector could distinguish "long turn in progress" from "wedge" via a beat-during-tool-use
  signal — not built.
- Worker wedge recovery is a separate arc. This ADR is control-plane-only.

## Verification

- Live: `bash -n` clean. Fresh heartbeat → no-op. Stale heartbeat + no workspace → spawn.
  Stale heartbeat + recent recovery stamp → cooldown log-only.
- The auto-recovery path itself was smoke-tested on this machine: with no titled
  control workspace and a stale heartbeat, the watchdog spawned a fresh control at
  `workspace:44` on 2026-07-14T20:00:17Z.

## Related

- ADR-0081 (D4 singletons + state integrity) — this ADR closes the "log only" loop end
  of it.
- Bug B4 in the 2026-07-14 full-system review — this ADR eliminates the last remaining
  case where B4's fix (heartbeat) still needed human hands.
