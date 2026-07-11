# `ccs resume <fleet>` is an idempotent reconcile keyed on cwd

> **Status: SUPERSEDED (2026-07-09) by ADR-0014 + ADR-0016 (and ADR-0032).** The
> idempotent-reconcile PRINCIPLE stands — resume converges the fleet, touching only what's
> wrong, and never spawns a duplicate. But the KEY is no longer cwd. ADR-0014 records
> `session_id → cmux ref` at spawn and keys liveness on that recorded ref; ADR-0032
> defines the full detection chain (recorded ref → cwd → title) + atomic-drain safety net;
> ADR-0016 requires the sweep to cover all windows. Read this ADR for the reconcile intent;
> treat every "keyed on cwd" statement below as replaced by the ADR-0014/0032 detection
> model. Implementers must NOT rebuild cwd-keyed liveness — that reintroduces the volatile-
> handle bug ADR-0014 killed.

The new resume-a-constellation feature (ADR-0006) must define what happens when
some fleet members are already live. Verified in ccs @ master: single-session
`ccs resume` has NO already-live guard (src/resume/cmux.ts is "fire-and-forget";
inline.ts just spawns claude), so resuming a live session would spawn a DUPLICATE
pane — the collision the architecture forbids. The packet's resume-fleet.sh
prototype dedupes (reuse-if-live) but that logic lives in bash, not in ccs.

Decision: `ccs resume <fleet>` is an IDEMPOTENT RECONCILE. For each fleet member:
if it is already live, leave the process alone but RE-ANCHOR its registry ref from
ground truth; if it is dead, resume it via cwd->resume_id. Converges the fleet to
"every intended member live + correctly anchored," touching only what is wrong.
Safe to run after a reboot, after a partial crash, or just when unsure. This fuses
the packet's Design-Rec #4 (re-anchor before routing) into resume, so live and dead
members both come out correctly routed.

The liveness check keys on the STABLE cwd (worktree path), matching
session_liveness.py — NEVER on workspace:N or on tab title. This is the specific
fix for Fault-1 (volatile cmux handle). Build note: open-state.ts currently joins
on workspace TITLE; resume-idempotency must join on cwd instead.

Rejected: (B) resume-all blindly — duplicate panes. (C) hard-error on any live
member — a normal "3 of 16 still up" reboot would abort instead of healing.
