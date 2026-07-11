# Control-wake is an event-file marker plus a short heartbeat poll

The concierge can dispatch workers live and fires a "control-wake" so the board
doesn't stay stale until the next 15m heartbeat. A long-lived turn-based session
cannot be interrupted mid-thought, so "wake now" needed a concrete mechanism.

Decision: the concierge (or a worker Stop-hook) writes a control-wake marker file;
the control plane polls it on a short interval (~60-90s) and runs a full sense/route
tick on marker-or-heartbeat. This matches the v2.1 architecture's worker->orchestrator
event-queue conclusion (hooks cover our own sessions, heartbeat covers the outside
world) and the determinism ethos (disk is truth, the queue mediates, nothing lost if
the target is busy).

Considered and rejected: a true push that actively resumes a sleeping session
(claude --resume fired by the hook) — it is the unproven mechanism v2.1 explicitly
left open, and it can collide with a tick already running.
