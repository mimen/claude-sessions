# Production-readiness findings (discovery sweep 2026-07-11)

Consolidated output of the parallel discovery sweep. RAW findings from subagents; NOT yet
deduped against existing ADRs/code. Synthesis (task #15) filters these into tracked tasks + ADRs.

Status of investigations:
- [x] Recent ccs session transcripts (e13ef543, 6f4c448e, 2a3c4ec5, e32771c2)
- [x] Prior designer transcript (aea5bc4f + designer-cwd)
- [x] DRY + determinism audit (see checklist U4/U9/CI-1)
- [ ] Dead code + boundaries + naming + errors — running
- [x] Hook system audit (see checklist U10/U11)
- [x] cmux coupling surface
- [x] Test-coverage gaps (folded into checklist per-unit)
- [x] CLI ergonomics + config (see checklist U19)

NOTE: findings are now decomposed by SYSTEM UNIT in docs/PRODUCTION-READINESS-CHECKLIST.md —
that is the burn-down artifact. This file keeps the raw per-audit detail.

---

## A. Recent-ccs-session miner (acef6f68) — 60MB across 4 sessions

NOTE at synthesis: several of these are ALREADY in ADRs (0018 global-hooks, 0027 statusline,
0042 env-scrub, 0049 path repoint). The miner had no ADR access to dedupe. Flag the genuinely
un-captured ones. ALSO NOTE a possible CONTRADICTION to verify: item 27 says env-scrub is
mandatory, but this session's ADR-0054 work concluded the OPPOSITE (no-scrub, plain command, so
the 0.64 shim registers the session). The transcripts predate the 0.64 fix — resolve which is
current truth (ADR-0054 wins; the scrub was retired for the detached path).

### Decisions possibly not yet in ADR/code
1. Spawn detached by default, `--inline` opt-in only (likely = ADR-0042; verify).
2. `ccsRuntimeRoot()` must honor `$HOME` before `os.homedir()` (Bun resolves homedir from OS user
   info, ignoring `$HOME`) — tests polluted real `~/.ccs` otherwise. VERIFY this fix landed.
3. Role-dir settings.json hooks don't resolve (CC discovery anchors to cwd, not role dir) → all
   hooks materialize to global `~/.claude/settings.json` with self-filtering (= ADR-0018).
4. Resume paths must unify — one `spawnDetached` primitive shared by TUI/CLI/new-session. The
   brief's "collapse executeSystemResume" — note execute-system.ts is now DELETED, so partly done.
5. Config resolution order deterministic: identity > role > cluster > global; resolve from
   session_id→row, never from cwd/env (= ADR-0043/44/45).
6. Hook merge semantics vary by type: cmux-paint=most-specific-wins, claude-md=ordered concat,
   meta-update=set-union, start/stop=ordered phases (= ADR-0044).
7. Statusline self-filters, global, catalogue-driven (= ADR-0027).
8. Board/gate/pending sensed fresh, never stale-read; repointed to ~/.ccs/cache (= ADR-0049).

### Gotchas / footguns (operational — feed the runbooks)
9.  SIGTERM is ignored by cmux-managed claude procs; cmux restarts them. Only SIGKILL works when
    cmux server is dead. Clean shutdown = close cmux workspaces, NOT kill PIDs. [RUNBOOK]
10. cmux auto-resume can respawn killed workers (`autoResumeAgentSessions`); SIGKILL just triggers
    respawn. To stop a fleet: close workspaces or disable autoResume first. [RUNBOOK]
    (Note: this session set autoResumeAgentSessions=false in cmux.json.)
11. Tests wrote to live ~/.ccs before the $HOME fix (e.g. board.json overwritten by test runs).
12. Context-lens TUI tests wrap on terminal width (80-col) — assert stable footer token, not the
    wrapping header line.
13. Epic mojibake was STORED data (bad encoding from GUS query), not a renderer bug — fix at the
    sensor (catalogue_sync), not the renderer.
14. Spawn-location hook fires BEFORE session_id exists — must resolve from launch request /
    responsibility spec, then bind to the row after creation.
15. Duplicate arm notes when both handleSessionStart and start-actions run `arm` — start.json
    presence should own arming; handleSessionStart built-in is backstop.
16. cmux-paint tab-rename lag after resume (~300ms for cmux to process spawn before `tree` is
    ready) — fixed by spawnCmux returning the surface ref directly for immediate paint.
17. Role symlinks in ~/.claude/ break if target moved (role packages → ~/.ccs-config); sync-roles
    reconciles atomically.

### Deferred ideas / tech debt
18. CCS-internal event bus — roles subscribe to ccs lifecycle moments (on phase-change, on resume,
    on tab-repaint), independent of CC's hook events. [CANDIDATE FEATURE]
19. Collapse executeSystemResume onto resumeClusterEntry (partly done — file deleted; verify no
    reimplementation remains).
20. Placeholder→real PR key migration (#36): migrate key + result-file names to canonical
    heroku/dashboard/1234 when a placeholder session later maps to a real PR.
21. Determinism harness for display bugs — read resolution code first, not repeated live-state
    archaeology (process lesson).
22. Session-level metrics/observability (uptime, cycle count, error rate) to detect stuck/flaky
    workers. [CANDIDATE FEATURE]
23. role.toml over sqlite for role metadata (= ADR-0050, done).
24. Epic entity (sensor-written) vs epic gotchas (human-authored) — different sources, not obvious
    from file layout (doc clarification).

### Rationale worth preserving (feeds docs/glossary)
25. Global hooks + self-filtering: CC anchors discovery to cwd (the work target), never the role
    folder, so role-dir settings are inert.
26. Statusline shares phase vocabulary with renderTab; single source = catalogue row `phase`.
27. [CONTRADICTED by ADR-0054 — see note above] env-scrub for detached spawn.
28. sense.sh runs `--keep --write` every tick → pending.json always fresh (fix for the 7→14
    events-no-drains bug 2026-07-02).
29. board/gate external-sensor-driven, not session-remembered (git/GitHub state is deterministic
    from the sensor; session memory would drift).
30. meta-update is set-union not object-merge (distinct facts from different levels).

### cmux/spawn/resume specifics (VERIFY against ADR-0054 — some predate the 0.64 fix)
31. OLD model: CMUX_SURFACE_ID = panel.id; binding = panel.terminal.agent.sessionId. THIS IS THE
    RETIRED SCHEMA (ADR-0054 moved to the hook store). Historical only.
32. Claim "0.64.10→0.64.17 is additive, bridge unchanged" — CONTRADICTED: ADR-0054 shows the
    app-state file stopped recording agent.sessionId; the bridge DID have to change. The miner
    read an earlier (pre-fix) session. Current truth = ADR-0054.
33. spawn-verify.sh proves 4/4 spawn isolation (check this script still exists/passes).
34. SessionStart hook rebinds surface on resume (self-heal).
35. Phase machine states tracked in catalogue `phase`; vocab shared renderTab+statusline.

### pr-watch specifics (feed cluster runbook #16)
36. Control loop is the primary sensor; scout feeds supplementary. Control keeps its own sensing.
37. Concierge dual-relays: to worker (speed) and to control (ledger/sync).
38. catalogue_sync writes epic ENTITY from GUS; epic gotchas are separate human-authored notes.
39. Workers launch under cmux inline `--settings` (don't load global settings.json) → need a
    worktree-local statusline; global covers non-workers.
40. pending.json is the always-read surface; written every tick; must never be stale.

---

## B. Prior-designer miner (a72de0d7) — aea5bc4f (45MB, ~180 user turns) + designer-cwd

Higher-altitude: architectural RATIONALE that predates the ADRs. Full report requested to
docs/FINDINGS-designer-transcript.md (see that file for evidence quotes). Headlines:

### Critical bugs/gotchas
B1. Claude Code sends the wrong `cwd` to cmux's resume binding → breaks NATIVE cmux resume; ccs
    derives its own launch dir to be immune (= ADR-0021/0042 rationale). [VERIFY still true post-0.64]
B2. cmux workspace TITLE collision causes session misdirection (silent overwrites) when two
    workspaces share a title — the reason identity/liveness keys on surface UUID, not title. [RUNBOOK]
B3. Role-directory hooks don't resolve (CC config discovery limitation) — corroborates A3/ADR-0018.

### Major architectural decisions (rationale not fully in ADRs)
B4. Control-plane / concierge SPLIT rationale: solves mid-conversation nagging — control senses/acts
    on cadence, concierge judges WHEN to surface to Milad. Why the fleet is two halves. [DOCS/glossary]
B5. Durable identity key formula (responsibility = cluster·role·work-unit), NOT session-id — the
    keystone that makes resume lossless. [DOCS/glossary — this is THE core concept]
B6. Inbox scoping is role-based (responsibility), not session-based — mail survives resume.
B7. Sessions are closable/resumable VESSELS; identity outlives the vessel. [DOCS/glossary]
B8. "Cluster" is the chosen public term, not "fleet" (terminology decision).
B9. cmux tab determinism via the identity key (not position/title).

### Deferred ideas (with design detail)
B10. Epic URLs + short names in cluster view.
B11. A ccs TUI for fleet visualization (partly exists — src/tui/).
B12. Non-PR workflows support (generalize beyond pr-watch — ties to grouping generalization).
B13. Slack scout as a third sensor with a detailed classification-precedence spec (now built as
     slack-scout — check the precedence spec made it into the skill).
B14. Agentic upkeep runbook (this is literally tasks #3/#16 — confirms the need).
B15. A "V3 learnings" doc exists and was flagged for review — FIND IT (may hold more context).

### Operational gotchas (feed runbooks)
B16. Workers hang on interactive prompts unless launched with acceptEdits — launch-mode footgun.
B17. Statusline backfill behavior on cold start.
B18. PR template drift.
B19. Screenshot quality gate (Cursor review) for UI PRs.
B20. PR comment-reading gap (worker didn't read all review comments).

### Follow-up dispatched
- Asked this agent to write its FULL report (with evidence quotes) to
  docs/FINDINGS-designer-transcript.md so the detail isn't lost to its transcript.

---

## C. cmux coupling-surface audit (adee59ed) — the most actionable

**Surface size:** 11 distinct cmux subcommands, 22 call sites, 8 files. Core = src/cmux/ (3 files).

### The dependency surface (what breaks on a cmux change)
- `tree --all --json --id-format both` (live.ts:35) — reads windows/workspaces/panes/surfaces
  {id, ref, type, title, index_in_pane, tty}. **Fail-CLOSED** (correct, ADR-0054).
- hook store `~/.cmuxterm/claude-hook-sessions.json` (live.ts:24) — reads
  `activeSessionsBySurface[uuid].sessionId` (the join) + `sessions[id]` detail. **Fail-CLOSED.**
- `new-workspace` (spawn-cmux.ts:38) — ref extracted by REGEX `/workspace:[0-9]+/` on stdout.
  **Fail-closed on spawn, but ref-miss = silent (tab never painted).**
- Best-effort (9): select-workspace, focus-window, rename-workspace, workspace-action, set-status,
  send, send-key — all `catch`→false, cosmetic.
- **LEGACY fail-OPEN path still present:** `src/catalogue/open-state.ts` uses `tree --json` +
  `list-workspaces --json` joined on TITLE (normTitle glyph-strip), catch→null = "nothing open".
  This is the dangerous one — predates ADR-0054's surface-UUID join, should be retired.

### Findings ranked (→ tasks)
- **P0-1 [→ #6] No cmux version guard.** cmux <0.64 → no hook store → "nothing open"; cmux 0.65
  schema change → unparseable → fail-closed stuck. Add `cmuxVersion()` probe in live.ts:58; require
  >=0.64 for hook store, warn on >=1.0. **This is exactly task #6, now with an implementation sketch.**
- **P0-2 [→ #6/#9] Hook store path hardcoded, no fallback.** Add `CMUX_HOOK_STORE_PATH` env override
  (live.ts:24); consider probing cmux for its store path.
- **P0-3 [→ #9] `new-workspace` ref via bare regex.** Format change → ref=null → eager paint skipped.
  Harden: parse JSON first, regex fallback; or request upstream `new-workspace --json`.
- **P0-4 [→ #9] spawn-cmux.ts:41 Bun.spawnSync has NO explicit timeout** (relies on Bun default).
  Add `timeout: 10000`. Small, do early.
- **P1-5 [→ #5/#9] Retire the legacy open-state.ts title-join fail-OPEN path** — migrate callers to
  the surface-UUID bridge; it's the remaining duplicate-spawn vector when a probe errors.
- **P1-6 [→ #13] list-workspaces --json has TWO schema variants** already; fragile to a third. Retire
  with the legacy path.
- **P2-7 [→ #9] Best-effort tab-paint ops: no retry** — add 2x/500ms backoff on rename/workspace-action.
- **P2-8 [→ #9] wakeSurface send/send-key: no delivery confirmation** (durable inbox covers it, slower).
- **P3-9 [→ #13] catch blocks swallow cmux error detail** — log actual error (stderr), add CCS_DEBUG.
- **P3-10 [→ #13] No cmux call latency/failure metrics** — wrap execFileSync in a traced helper.
- **P3-11 [→ upstream, #13] Request cmux expose a stable liveness API** (`list-sessions --json`) so ccs
  doesn't hand-intersect tree+store; and a hook-store `version` field so schema drift errors loudly.

### Timeout inventory (all present EXCEPT spawn-cmux): tree 2s, select/focus 3s, rename 4s,
### workspace-action/set-status 4s, send/send-key 3s, list-workspaces 2s. spawn-cmux = MISSING.

VERDICT: surface-UUID join + fail-closed is CORRECT for 0.64.17. P0 gaps (version guard, hardcoded
path, regex ref, missing spawn timeout) are tolerable single-user but block multi-machine/version-
varied deployment. Phase 1-2 hardening → production-grade.
