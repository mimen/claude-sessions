# Cold-start (post-reboot) is a manual `ccs resume <fleet>`, not an auto boot trigger

After a reboot the whole fleet is cold. Options for what brings it back: purely
manual, a login LaunchAgent that auto-resumes everything, or a minimal always-on
trigger that resurrects only the control plane which then revives the rest.

Decision: PURELY MANUAL. Milad runs `ccs resume <fleet>` (resolving the fleet by
its tag, ADR-0006), exactly like resuming a single session — he decides when and
watches it come back. No LaunchAgent, no auto-resume of ~19 sessions before he has
opened a terminal. Reboots are rare and he is present for them; the packet's
prototype already dry-runs 16/16 clean.

Rejected: (B) LaunchAgent auto-resume — too much unsupervised startup + a new
always-installed daemon. (C) minimal control-only boot trigger — deferred; see the
tension below.

## Refinement (2026-07-08): once control is UP, IT owns the bulk resume
The original decision conflated two things: WHO triggers the first control session
(still manual — Milad, or a heartbeat he opts into) and WHO runs the fleet resume.
The rejection in (B) was about resurrecting ~19 sessions *unsupervised, before Milad
has even opened a terminal*. That concern does not apply once a control session is
already running: control-up is itself a deliberate act. So the Revive step of every
control tick now LEADS with `ccs resume pr-watch` (made idempotent — reuses live
workers, revives only the dead, dedups multi-session work units, skips completed).
This also retires prose that told the control agent to hand-revive each dead session
from `liveness.json` — mechanical work that belongs in the script (the founding
rule). What stays MANUAL is unchanged: the FIRST control session after a reboot
(Milad starts it, or arms the heartbeat). What's now AUTOMATIC: everything the fleet
needs once that driver is up. The one guard: control never re-spawns a worker Milad
deliberately closed — `ccs resume` reconciles toward the tracked fleet, and a
deliberate close is surfaced, not fought.

## Open tension with ADR-0002 (must resolve next)
ADR-0002 put the control plane on a cron heartbeat to prevent the ~4-day dormancy.
A purely-manual cold-start means: after a reboot, does the steady-state control
cron come back on its own (a persisted launchd/cron job survives reboot), or is the
ENTIRE loop — including the control heartbeat — down until Milad manually resumes
the fleet? If the latter, "manual cold-start" and "cron prevents dormancy" only
coexist because reboots are rare: while the machine is UP, control cron-ticks and
can't go dormant; a reboot is the one window where manual restart is required. That
is coherent, but it must be stated, because it means the anti-dormancy guarantee is
"no dormancy while powered on," not "no dormancy ever." To be confirmed in Q7.
