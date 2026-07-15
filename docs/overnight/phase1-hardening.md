# Phase 1 — Overnight Hardening

**Branch:** `overnight/harden-and-dogfood` (in `~/projects/claude-sessions`)
**Companion branch:** `overnight/signal-scout` (in `~/.ccs-config`)
**Loop:** `/loop 30m /overnight-harden` — every 30 min, one tick.
**Exit trigger:** when every acceptance box is ticked AND no novel-idea has been added in the last 2 ticks, write `PHASE1_DONE` sentinel + spawn Phase 2.

## Goal

Prove that ccs post-ADR-0089 is production-solid. Find every plausible failure mode across the tool, fix it, prove the fix with a test, commit it. When the tester (that's you, next tick) can't invent a new failure mode after real exploration, Phase 1 is done.

## Method — the loop tick

Each tick you run:

1. **Read this file.** Especially the punch list at the bottom.
2. **Pick the top unchecked idea.** If none, **explore** for 15 min: run commands, exercise surfaces, look for gaps. Anything you find gets appended to the punch list.
3. **Work the item:** write a failing test that reproduces it → fix the code → the test now passes → commit with a message that names the failure mode.
4. **Tick the box** in this file. Commit that too.
5. **Check acceptance criteria** (below). If all green AND the punch list has stayed empty for 2 consecutive ticks → write `PHASE1_DONE` sentinel + spawn Phase 2.
6. **Log the tick** in `docs/overnight/log.md` (one line: timestamp, what you did, what you found).

## Acceptance criteria (ALL must hold to exit)

Check each on every tick; leave visible boxes here so the loop can see progress.

- [ ] `bun test` reports **0 failures**, no `.skip`, no `.todo` newly added by this branch.
- [ ] `bun run typecheck` (or `bun tsc --noEmit`) is clean.
- [ ] Every subcommand printed by `ccs --help` has been invoked at least once against a fresh `:memory:` or tmp-dir DB without a crash. Track this in `docs/overnight/surface-coverage.md`.
- [ ] Round-trip lifecycle: `identity mint` → `session set --identity` → `session complete` → `session archive` → `session unarchive` → `identity ls` reflects each step. Add as a real test.
- [ ] `resume-cluster pr-watch --dry-run` completes without spawning phantom sessions or leaving null-cluster orphans.
- [ ] Zero rows where `catalogue.identity_key IS NULL` AND the session's `cwd LIKE '%.ccs-config/clusters/%'` (checked against a scratch copy of the live catalogue).
- [ ] `mark --archived` on a session attached to a **core** identity leaves the identity `archived=0` (regression test for tonight's fix — already added, keep green).
- [ ] `mark --completed` on a session attached to a **fleet** identity DOES cascade (retire path stays intact).
- [ ] `writeSessionMetadata` for the 2nd worker on a PR archives the 1st (supersede) AND keeps the fleet identity alive.
- [ ] `dedup-sessions-per-identity.ts --apply` is idempotent (2nd run archives 0).
- [ ] `backfill-identity-from-cwd.ts --apply` is idempotent.
- [ ] `ccs sync-tabs --all` on the live catalogue completes without spawning duplicate cmux tabs (dry-run first).
- [ ] Punch list has been empty at end-of-tick for 2 consecutive ticks.

## Punch list (start here; append liberally)

Format: `- [ ] <one-line failure mode> — <where to look>`

- [ ] `session complete <id>` where `id` isn't a UUID (e.g. `agent-abc…`) — does it 404 cleanly? — `src/catalogue/session-command.ts`
- [ ] `identity set <key> --unknown_field=x` on a core identity — should error with a "no per-role table" message, not silently no-op — `src/catalogue/identities.ts:222`
- [ ] `identity mint` called concurrently for the same key from 2 processes — do we get 2 rows or 1? — check UNIQUE constraint
- [ ] `resume <selector>` with a selector that matches 0 sessions — exit code, error text
- [ ] `resume <selector>` with an ambiguous selector (`#12080` when 2 repos have PR 12080) — behavior + prompt
- [ ] `board <cluster> --recompose-all` on a fresh cluster with no board.json yet — crash or clean empty?
- [ ] `catalogue export` on an empty cluster — `{"rows": []}` or error?
- [ ] `session set <id> --identity=<key>` where `<key>` doesn't exist — should refuse (FK-like) — currently just writes; check `src/catalogue/session-command.ts`
- [ ] `session set <id> --parent=<id>` (self-parent) — reject
- [ ] `session set <id> --parent=<nonexistent>` — reject or store forward-reference?
- [ ] `identity archive <key>` then `session complete <sid>` where sid is attached — does un-archive happen? Read the mirror carefully.
- [ ] TUI: expand a section that has 0 sessions after retire cascade — is the "(0)" count correct?
- [ ] TUI: an identity with ALL sessions archived but identity itself active — currently hidden or shown?
- [ ] `ccs inbox drain <key>` when the identity has 0 messages — clean exit
- [ ] `ccs cluster init <name>` twice — second run refuses or overwrites?
- [ ] `ccs whoami` outside of a Claude session — exit code, error text
- [ ] Long identity_key with special chars (`heroku/dashboard#12080` — the `#` is fine, what about spaces?) — mint accepts?
- [ ] SQLite `PRAGMA integrity_check` on a live catalogue at start of every tick — no corruption
- [ ] `catalogue.db` file is a symlink or on a network mount — do transactions still work?
- [ ] Test with `TZ=Pacific/Kiritimati` — any date-string comparisons that break at day boundaries?
- [ ] What happens if you spawn a session with `--role=<role>` but no `--cluster`? — `writeSessionMetadata` — does it derive cluster from role registry?
- [ ] Two clusters both have a `pr-agent` role — role registry lookup, does it collide?
- [ ] `identity path <key> --new` creates a dir; delete it manually; re-run — recreates?

Add findings here as you go. Every idea, even ones you rule out, gets a checkbox — checked means "verified safe" or "fixed", not just "considered".

## Constraints

- **Don't break the pr-watch cluster.** It's live. If a change would require a coordinated ccs+ccs-config update, park the change on the branch, note it in the log, and don't commit to master.
- **Every fix ships with a test.** No "verified by hand".
- **Never `git push --force` or `git reset --hard` on any branch.**
- **Never mock `~/.ccs/cache/*.db` writes in tests.** Use `:memory:` or a `tmpdir` — the live DB stays out of test runs.
- **Never post to Slack** or any external service in Phase 1. This is code-only.

## Handoff to Phase 2

When exit criteria are met, this loop:

1. Writes `docs/overnight/PHASE1_DONE` with a summary of what was fixed.
2. Spawns Phase 2 via `ccs session new --cwd ~/.ccs-config --title overnight-signal-scout --prompt "/loop 45m /overnight-dogfood"`.
3. Marks itself completed (`ccs session complete .`) so the phase-1 loop stops on the next tick.

The phase-1 loop is done. Phase 2 takes over.
