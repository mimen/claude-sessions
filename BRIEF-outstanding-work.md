# Brief: outstanding work across the ccs platform + pr-watch cluster

Written 2026-07-11 after a long build arc (worker phase state machine, tab pills, the cmux 0.64
liveness fix). Everything below is verified against the actual repo state, not memory. Two repos:
**ccs tool** (`~/projects/claude-sessions`) and **cluster config** (`~/.ccs-config`). Nothing is
committed since the fresh work started — `git status` in both shows the full working set.

---

## 0. IMMEDIATE — 3 failing tests (must fix first, ~5 min)

`bun test` → **3 fail**, all in `src/resume/resume-cluster.test.ts`:
- "resume-cluster fans out over members; dry-run resumes the closed ones"
- "a member that isn't indexed is counted, not fatal"
- "completed + archived members are retired, never resumed (ADR-0010)"

**Cause (not a logic bug):** the fail-closed guard (ADR-0054) added `bridge.readable` and
`resumeMany` now aborts when it's falsy. These three pre-existing tests build stub bridges that
predate `readable`, so it's `undefined` → the pass aborts → assertions fail. **Fix:** add
`readable: true` to those stub bridges (the new abort test at line ~115 already does this correctly;
mirror it). tsc is already clean (0 errors).

---

## 1. cmux 0.64 liveness fix — DONE, needs live end-to-end confirmation

The previous designer (spawned properly inside cmux) fixed this. Verify it's fully landed:
- `spawnCmux` (`src/resume/spawn-cmux.ts`) spawns a PLAIN command (no `exec`, no CMUX_SURFACE_ID
  scrub) so cmux's claude shim registers the session. `new-session`'s `spawnDetached` uses it too.
- Bridge rewritten for 0.64 (`src/cmux/live.ts` + `bridge.ts`): reads `~/.cmuxterm/
  claude-hook-sessions.json` (`activeSessionsBySurface[surfaceUUID].sessionId`), `readable` flag added.
- Fail-closed guard (ADR-0054): `resumeMany`/`resumeSessionEntry` abort (spawn nothing) when
  liveness is unreadable, instead of duplicating the fleet. `abortedUnreadable`/`liveness-unreadable`
  statuses added.
- The hook store currently shows 12 sessions (tracking works); 0 live claude procs right now.
- **TODO:** once tests are green, do ONE live end-to-end from inside cmux: `ccs resume-cluster
  pr-watch --dry-run`, then confirm a real resume registers + doesn't duplicate. Delete the
  now-obsolete `HANDOFF-cmux-064-fix.md`.

## 2. ADR numbering collision — TWO ADR-0053s (must resolve)

`docs/adr/` has both:
- `0053-inference-engine-is-pluggable-codex-or-claude.md`
- `0053-kind-is-a-property-of-the-role-not-the-session.md`

Renumber one (0055 is free; 0054 is taken by the cmux fix). Fix any cross-references. Decide which
keeps 0053 by creation order / cross-links.

## 3. Worker phase state machine — BUILT, untested live

Model: **stage × activity** (`~/.ccs-config/clusters/pr-watch/roles/pr-agent/docs/phase-state-machine.md`).
- stage: building → milad-review → in-review → approved → merged (monotonic, engine-latched).
- activity: dormant (bare stage) / needs-you / fixing. No "working" — dormant is rest.
- Commands: `ccs activity . needs-you|--off`, `ccs ready .`, `ccs approve <selector>`.
- Engine (`catalogue_sync.py`) senses stage + `fixing`; worker self-reports needs-you.
- Turn-boundary rubric hook: `worker-stop-command.ts` injects the rubric each turn (pr-agent only);
  `phase-rubric.ts` holds it; pr-agent `claude-md.md` primes it at start.
- **TODO — never run against a LIVE worker.** When the fleet is up: confirm a real pr-agent's tab
  shows the right stage·activity pill, `ccs ready` latches milad-review, `ccs approve #<pr>` advances
  to in-review, `needs-you`/`fixing` overlay correctly, and the turn-end rubric actually appears in a
  worker's context. Watch for the `ccs activity` usage string — it still says `<working|needs-you>` in
  cli.ts help (line ~56) but "working" was dropped; update help to `needs-you` only.

## 4. Core-role + worker tab pills — BUILT, untested live

- Core roles: `pr-watch • <role>` titles + colors (control=Indigo, slack-scout=Teal, eval=Amber,
  concierge=Rose, designer=Magenta) via per-role `cmux-paint.json`. Loop pills (control health /
  concierge queue / eval grade) via `loop_status.py` → `computeLoopPill`.
- Workers: no sidebar color, epic in description, stage×activity pill.
- Freeform `ccs status . "<line>"` line (any role) takes the description slot.
- **TODO:** eyeball all of it live once the fleet is up. `loop_status.py` only had eval to write when
  tested (rest archived). Confirm control/concierge/eval pills populate on a running fleet.

## 5. Tab-repaint freshness — BUILT

Stop hook repaints the tab every turn; `sense.sh` runs `ccs sync-tabs --all` each tick; eager paint
on resume. Verify no regressions once live.

---

## DEFERRED / IDEAS RAISED, NOT STARTED

- **CONTEXT.md rewrite** (ccs repo): still describes only the old session-browser; zero cluster/
  role/identity/hook/stage-activity vocabulary. A real glossary rewrite (the whole platform arc is
  absent). Flagged repeatedly; never done.
- **New-cluster / new-role front door** (candidate C from the architecture review): a wizard to
  bootstrap a cluster/role from scratch. The whole "test it out by standing up event-watch" idea.
  Never built.
- **ADR de-leak pass:** strip ~152 ADR-refs + war-story comments from code, keep one `@decision` per
  module header. Deferred as its own pass.
- **File 2 upstream cmux/CC issues (ADR-0021):** the resume-cwd-drift bug + expose sessionId. Now
  partly OBE (0.64 changed everything) — revisit whether still worth filing. Outward-facing, needs
  Milad's OK to post.
- **Identity work-unit-key dedup** (Candidate 3): six copies of the work-unit key logic still exist.
- **Determinism holes** (D1 spawn TOCTOU, D2 lineage tie-break, D3 mergeFields lock) — documented,
  not fixed.
- **`ccs role rename`** primitive: renaming a role dir orphans a live session's transcript folder
  (the scout→slack-scout incident). Should migrate storage folder + reindex atomically. Recorded in
  ADR-0052 consequences; not built. The front-door wizard should own this.
- **Running-fleet backfill:** sessions launched the OLD way (pre-spawn-fix) aren't in the hook store.
  New spawns track; existing ones become trackable on natural restart. Decided low-priority; no
  backfill built.
- **The epic→grouping rename** and generalizing groupings beyond GUS — deferred in ADR-0051.

## PROCESS NOTES / GUARDRAILS (still in force)

- **Agents do NOT resume the cluster.** control/concierge skills updated to ban `ccs resume` from
  ticks (caused a duplicate-fleet runaway). Resuming is Milad's explicit action or a scheduler.
- **Commit/push only when Milad asks.** Nothing committed yet this arc — a LOT is uncommitted in both
  repos; a clean commit-grouping pass is itself outstanding work.
- **Live DB migrations hit the pre-bumped-version trap** repeatedly (v16–v19): a fresh `:memory:` db
  migrates correctly, but the live db's user_version was already bumped, so ADD COLUMNs were applied
  by hand. If setting up a new machine, the migrations are correct; the live db was patched manually.
- cmux config (`~/.config/cmux/cmux.json`): `sidebar.showBranchDirectory=false` +
  `terminal.autoResumeAgentSessions=false` (both set this arc). The cmux socket needs AUTH — a
  non-integrated background shell can't drive cmux; run ccs from inside a cmux surface.
- Outward-facing writing (PR/Slack/GUS): human voice, no em-dashes, no AI throat-clearing.
