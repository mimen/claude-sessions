# Control plane is a long-lived session woken by cron, with the v21 compaction guard

Two shapes were on the table: (a) a fresh light session spawned per cron tick that
rehydrates from disk and exits (never overflows, forces a bounded rollup, but loses
warm cross-PR routing memory), or (b) one long-lived session woken by cron that
keeps warm context and compacts via the v21 orchestrator_ctx guard.

Decision: (b) long-lived + v21 guard. Cross-PR routing reasoning (conflict/keystone
analysis) benefits from staying warm in-context, and it is a smaller change from
today. Cost accepted: compaction must work headless, and the per-tick rollup-log
cruft (60+ tickNNNN keys today) must be bounded separately.

Cron (not /loop) is the driver so the loop survives session death and human absence
(the /loop session dying is what caused the ~4-day dormancy). Heartbeat floor ~15m,
run-and-measure the token cost before tuning the interval or adding quiet-board
backoff.

## Amendment (ADR-0012)
The anti-dormancy guarantee here is scoped to "no dormancy WHILE POWERED ON," not
reboot-proof. The persisted control cron self-heals the control session while the
machine is up (covering crashes + idleness); fleet cold-start after a reboot is
manual (`ccs resume <system>`). See ADR-0012 for the full resolution.
