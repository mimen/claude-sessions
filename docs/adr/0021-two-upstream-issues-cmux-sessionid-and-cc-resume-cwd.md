# Two upstream issues (cmux + Claude Code) we file, plus our local fallback stance

Closes the last two fragilities from the architecture map: foreign-pane matching and
cmux resume cwd drift. Both turned out to be UPSTREAM issues (one cmux, one Claude
Code), not our bugs — our identity model (ADR-0014) already sidesteps them. Decided
with Milad 2026-07-09.

> **Amendment (ADR-0040, 2026-07-09): Issue 1 is DOWNGRADED.** A capability audit of the
> installed cmux found `tree --id-format both` now exposes a stable per-surface **UUID**,
> and the persisted state file keys each `agent` (with its `sessionId` + `resumeBinding`)
> under the `windows → workspace → pane → surface` tree. So the `sessionId → ref` join key
> DOES exist now: read the session id from the state file keyed on the surface UUID that
> `tree` reports — no cwd-join, no ambiguity, works for foreign panes too. Issue 1 is no
> longer load-bearing; the remaining upstream ask (expose `sessionId` directly in the
> `tree`/`list-workspaces` CLI output so no state-file read is needed) is a nice-to-have,
> not a blocker. Issue 2 (resume cwd drift) is UNCHANGED and still filed. See ADR-0040 for
> the full audit.

## Issue 1 — cmux omits the session id from `list-workspaces` (the bridge gap)

**What it is.** To ACT on a cmux tab (rename / color / liveness) you need its `ref`
(`workspace:60`). The Claude session id and the ref live in two files that share no
key:
- persisted state file: has `agent.sessionId` + `cwd` + `title`, but NO `ref`.
- live `list-workspaces --json`: has `ref` + `cwd` + `title`, but NO `sessionId`.

So mapping `sessionId → ref` for a pane requires joining the two on `cwd` (title is
rejected as a key). Verified live: 4 workspaces share `cwd=/Users/mimen`, so a cwd-join
is ambiguous — you cannot tell which persisted session id owns which live ref. cmux
ALREADY stores the session id (in the persisted file); it just doesn't expose it in the
live listing.

**Who it affects.** Only FOREIGN panes — ones ccs didn't spawn (a manually-opened
terminal running `claude`, or a case where ccs's recorded-ref registry is unavailable).
FLEET panes are immune: ccs spawns them and records `sessionId → ref` at that moment
(ADR-0014), exact, no join. So this only bites the general ccs TUI when it browses ALL
machine sessions, not the pr-watch fleet.

**Decision — both, file upstream AND ship the fallback:**
- SHIP NOW: fleet panes use the recorded-at-spawn ref (exact). Foreign panes use the
  cwd-join WITH an ambiguity guard — if >1 workspace shares the cwd, skip (don't guess),
  exactly as the current resolver does. Foreign-pane labeling is documented best-effort.
- FILE UPSTREAM: request (or PR) `manaflow-ai/cmux` to include `agent.sessionId` (and
  ideally the resume `checkpointId`) in `list-workspaces --json`. cmux already has the
  data; exposing it makes `sessionId → ref` exact for ALL panes.
- LATER: once cmux exposes it, DELETE the cwd-join fallback — the join becomes exact.

## Issue 2 — Claude Code sends the wrong cwd to cmux's resume binding

**What it is.** cmux's stored resume command can `cd` to the wrong directory, making
its OWN `claude --resume` fail "No conversation found." Root cause (confirmed by reading
cmux source + the persisted data): cmux faithfully stores whatever `cwd` Claude Code
sends it via the `surface.resume.set` control-socket call; Claude Code sends the
terminal pane's LIVE cwd (after any `cd`), not the session's ANCHOR cwd (the one encoded
into `~/.claude/projects/ENCODE(cwd)/<id>.jsonl`, which is where the transcript actually
lives). When the pane `cd`'d away from its launch dir, the two diverge and resume looks
in the wrong encoded folder. Observed live: a session created in `/Users/mimen` had its
resume binding record `/Users/mimen/.claude/pr-watch-2`.

**This is a Claude Code bug, not a cmux bug.** cmux stores what it is told; Claude Code
tells it the wrong directory.

**Who it affects.** cmux's own resume path. It does NOT affect ccs: `ccs resume` builds
the launch dir itself via `resolveResumeCwd` → `locateLaunchDir`, which WALKS the
filesystem to find the directory whose encoded realpath equals the session's storage
folder — i.e. it derives the correct anchor dir from the session id, ignoring any
drifted stored cwd. So our fleet resume is immune.

**Decision — file it upstream; we're already immune:**
- FILE UPSTREAM: file the drafted repro to Claude Code (it affects any cmux+claude user).
  Claude Code should send the session's anchor cwd (from the transcript's `cwd` field /
  the storage-folder path), not `$PWD`.
- OUR SIDE: no code change required — `ccs resume` already derives the launch dir. We
  document the immunity so nobody "fixes" it by trusting a stored cwd.

## Consequences

- Both remaining fragilities are now either resolved-by-our-model or tracked-upstream;
  neither blocks the fleet.
- Two upstream reports to file: cmux (expose sessionId in list-workspaces) and Claude
  Code (resume anchor-cwd bug). Both drafted.
- Reinforces ADR-0014: because identity is the session id and ccs records the ref at
  spawn + derives cwd on demand, both upstream defects route around us. The fallbacks
  (cwd-join for foreign panes; filesystem-walk for resume) are the safety nets.
