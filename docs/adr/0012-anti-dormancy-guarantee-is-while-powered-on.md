# Anti-dormancy guarantee is "no dormancy while powered on"; control heartbeat self-heals, fleet cold-start is manual

Resolves the tension flagged in ADR-0007: ADR-0002 put control on cron to kill the
~4-day dormancy, but ADR-0007 made cold-start manual — leaving open whether the
control heartbeat survives a reboot on its own.

Decisive fact: the observed 4-day dormancy (2026-07-02 22:00 -> 2026-07-06) happened
with the machine POWERED ON the whole time — no reboot. Nothing drove control while
up. So the failure to kill is "nothing drives control while powered on"; a reboot was
never the cause.

Decision:
- **Guarantee = "no dormancy WHILE POWERED ON"** (not reboot-proof). This precisely
  targets the observed failure.
- **Control heartbeat = automatic + self-healing while powered on.** A persisted
  launchd/cron job whose command is ensure-control-alive-then-tick: while the machine
  is up, if the control session crashes or idles, the next fire resurrects/ticks it.
  This also covers control CRASHES, not just idleness.
- **Fleet cold-start = manual** (`ccs resume <system>`, ADR-0006/0007). The heavy
  ~19-session part waits for Milad.
- **Reboot window collapses as a concern:** even if the persisted cron fires after a
  reboot and control returns on its own, control finds a COLD FLEET and surfaces "run
  `ccs resume <system>`" — it does NOT auto-resurrect workers. So control
  returning-or-not after reboot doesn't change the guarantee (the fleet is manual
  either way). This honors Q6-A (manual fleet cold-start) and the Q6 rejection of
  auto-resuming 19 sessions, while keeping the brain that prevents silent death
  un-killable while powered on.

Config knob: the control cron may auto-resurrect only the CONTROL session, never the
fleet, on a detected cold-start.

Rejected: (B-strict) nothing auto-recovers, even control — reintroduces the exact
human-in-the-loop dependency (remember to restart control) the whole split removes.
