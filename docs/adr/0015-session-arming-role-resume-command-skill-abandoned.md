# Session arming: `role` and `resume_command` replace `skill`; loops come back running

Sequel to ADR-0014. That ADR settled what a session IS (identity = the Claude
session id; the workspace ref is a while-open handle; cwd is derived). This one
settles how a session comes back ARMED — i.e. resuming a loop session must restore
it to a *running loop*, not a dormant conversation. Decided with Milad 2026-07-09.

## The bug this fixes

`ccs resume <system>` (and any single-session resume) spawns bare
`claude --resume <id>`. For a loop session that is WRONG: the driving invocation
(`/loop 15m /pr-watch-control`) is lost, so control comes back as a dormant pane, not
a ticking driver. cmux's own `resumeBinding` also dropped it (its stored command is a
bare `--resume`). So today, resuming the control plane does not restart it.

## The three fields

| field | purpose | who has it | set how |
|---|---|---|---|
| `role` | free-form, human-readable label; the grouping/display key in ccs | all sessions | at birth (`ccs new-session --role`), refreshable |
| `resume_command` | the WHOLE invocation to replay on resume | loop sessions only | (c) below |
| `skill` | ABANDONED — see below | — | — |

- **`role`** is free-form (a controlled set may emerge over time, but not enforced).
  It is decoupled from any backing command: a session's readable role need not map
  1:1 to a skill. `role` becomes THE label ccs groups + abbreviates by in the cluster
  view — the job the `skill` column used to do.

- **`resume_command`** is the entire thing to run on resume, e.g.
  `/loop 15m /pr-watch-control`. The interval lives inside it — there is no separate
  duration field. It is NEVER inferred from a session's launch prompt: a launch prompt
  is usually a one-shot task ("go fix #12113"), which must not be replayed on resume.
  Only sessions that should come back DOING something carry it.

- **`skill` is abandoned in place.** It is not for anything anymore. We stop writing
  and reading it; the column stays (no migration) but is dead. Everything that read
  `skill` (the cluster-map grouping + role abbreviation) moves to `role`. A future
  cleanup may drop the column; not now.

## How `resume_command` gets set — decision (c): spawn baseline + loop refresh

- **Spawn writes the baseline (deterministic).** The launcher passes it explicitly —
  `ccs new-session --resume-command '/loop 15m /pr-watch-control'` — and it is written
  to the catalogue at birth, keyed to the minted id (the M3 identity-at-birth pattern).
  This is a SEPARATE flag from `--prompt`; the prompt is the first-turn task, the
  resume-command is how to re-arm. new-session does NOT auto-copy the prompt into it.
- **The loop refreshes it (best-effort).** When the cadence changes, the running loop
  updates its own `resume_command`. If that self-update silently no-ops (the
  `$CLAUDE_CODE_SESSION_ID`-unset failure mode from ADR-0014's fragility list), the
  spawn baseline is still correct — worst case the cadence is stale, never missing.
- **Why (c) and not pure self-registration:** self-registration alone re-introduces
  the silent-no-op failure we are trying to eliminate. Spawn-baseline makes the value
  correct-at-birth without depending on any env var; the loop refresh is a pure
  enhancement layered on top.

## Resume behavior that falls out

- **Loop session** (`resume_command` set) → resume runs
  `claude --resume <id> '<resume_command>'` in the derived launch dir (cwd from
  ADR-0014). It comes back RUNNING. (`claude [options] [prompt]` accepts a trailing
  prompt with `--resume` — verified.)
- **Worker** (no `resume_command`) → bare `claude --resume <id>`; it picks up work by
  draining its O2 inbox at the next task. Workers are deliberately not armed with a
  resume command.
- **`ccs resume-session <id>` is the CORE operation** (Milad, 2026-07-09). It
  re-embodies one agent identity, replaying its `resume_command`. Everything is built
  on this single-identity primitive.
- **`ccs resume-cluster` is a thin convenience**: it runs `ccs resume-session` once for
  each identity in the cluster that is NOT currently open (skipping already-live ones).
  It is literally a loop over the primitive — no separate logic. Build/behavior
  priority follows: `resume-session` must be correct; `resume-cluster` is a workflow
  loop on top. (This replaces the earlier `ccs resume <system>` framing, which put the
  cluster verb first; the single-identity verb is the primitive.)

## cmux `resumeBinding` is NOT part of this

Correcting an earlier false parallel: ccs's `resume_command` and cmux's `resumeBinding`
are unrelated. We read `resumeBinding` for ONE thing only — extracting the Claude
session id from a live/foreign pane (ADR-0014's foreign-pane fallback). We do not use
it to resume, and there is no "authority" contest between the two. cmux's binding
carries the drifted-cwd bug (a Claude Code defect, tracked separately); it never
touches our resume path because our resume path is built from `resume_command` + the
derived launch dir, not from cmux's binding.

## Consequences

- Resuming a cluster (or one session) restores loops to running state — the "resume
  does everything necessary" requirement.
- `role` is now the single label; the cluster view groups/abbreviates by it. `skill`
  is dead weight pending removal.
- `role` and `resume_command` join the identity-at-birth set: set deterministically by
  `ccs new-session`, so a resumed/rebuilt session is fully armed without relying on a
  fragile in-session self-tag.
- Open follow-on: a SessionStart hook could REFRESH these on any start (including
  manual/resumed sessions new-session didn't launch) — same self-registration
  mechanism, tracked separately, not required for this ADR.
