# Production-readiness checklist — system decomposition + burn-down

The whole platform broken into **testable units**. Each unit is a thing you can point at, exercise,
and prove. Burn this down to reach production. Seeded 2026-07-11 from the discovery sweep (7 parallel
audits — see FINDINGS-production-readiness.md for the raw findings each row cites).

**Implementation status (2026-07-14 hardening arc landed):**

DONE:
- ADR-0054 (cmux 0.64 liveness), 0056 (sync-tabs selector paint), 0057 (work-unit entity),
  0058 (inter-layer version contract), 0059 (system→cluster rename), 0060 (meta map), 0061
  (tool=mechanism / cluster=policy), 0062 (role props from role.toml), 0063 (evict
  pr-sense from tool), 0064 (generic meta commands), 0065–0067 (circular-dep, error-
  handling, dead-code), 0068 (db.ts split), 0069/0070 (anchor + grouping types), 0071
  (Result<T> + structured logger), 0073 (one embodiment is a preference), 0074–0077
  (project-level materialization + spawn hook + roster JSON + phase-first board).
- 2026-07-14 hardening arc (this branch): **ADR-0078 D1 export boundary + identity key SoT**,
  **ADR-0079 D5 stage sensor-only**, **ADR-0080 D3 (cluster, role) identity**, **ADR-0081
  D4 singletons + state integrity (heartbeat + atomic claim + locked writes)**, **ADR-0082
  D8 board recompose is serialized**, **ADR-0083 D2/B11 board schema versioned + gate on
  every bring-online path**, **ADR-0084 wedged-control auto-recovery**, **ADR-0085 hook-
  store contradictions resolve to the fresher signal (B14)**. All three review P0s (B1,
  B2, B3) and every review P1 + P2 in scope are dead. B12 (activity docs sync) + B15
  (migration postcondition) + B13 (atomic unique-per-turn events) all landed.
- Live catalogue at v31 (identity-key backfill). e2e smoke test passing (12/12 gate
  entries match a board row). Toy second cluster proves cluster-scoped role resolution.

DEFERRED (Phase 2+):
- Full "versioned executable protocol" in cluster.toml (argv + protocol + timeout) — big
  refactor requiring every cluster to migrate.
- Event-coalesced recompose (D8 half two) — perf optimization, not needed under current
  cadence.
- New-cluster / new-role bootstrap wizard (task #11).
- D9 ADR consolidation + curated architecture doc + status front-matter on every ADR.
- Auto-recovery for wedged fleet WORKERS (control-plane recovery is now live in ADR-0084).

## How to read the columns
Per unit, an honest status on six axes. `✅` done · `🟡` partial · `❌` missing/unknown · `—` n/a.

- **Live** — have we actually USED it for real (not just dry-run)?
- **Unit** — unit tests exist and are meaningful (not stub-only)?
- **Integ** — an integration/end-to-end test exercises the real path?
- **Det.** — deterministic: same inputs → same result, stable tie-breaks, no fail-open?
- **Hard** — failure modes handled (timeouts, unreadable, retries, fail-closed where it matters)?
- **Doc** — documented for operate + extend?

Priority: **P0** blocks production, **P1** needed for confidence, **P2** polish.

---

## LAYER 1 — ccs platform core

### U1. Session indexing / incremental reindex  — `src/index/`
Live ✅ · Unit 🟡 (search only) · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡
- Risk: incremental reindex keys on mtime/size; if wrong, sessions vanish from TUI. Title COALESCE
  (native→codex→fallback), usage/subagent cost rollup all untested.
- TODO: write file→reindex→row; change→update; delete→remove. Cost-rollup assertion. [P1]

### U2. Catalogue DB + migrations  — `src/catalogue/db.ts`
Live ✅ · Unit 🟡 (accessors + drop/backfill migrations tested) · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡 — migrations exercised: live catalogue cleanly migrated v19→v26 this arc (meta add, milad/build→meta, event/skill/phase drops), no data loss. Remaining: a full v1→v19 chain test on :memory:.
- **CRITICAL:** migrations v1→v19 have ZERO tests; v16–v19 were hand-patched on the live db. v14/v15
  are deliberate DROPs (roles, epics) guarded only by version check. Idempotence (hasColumn) untested.
- TODO: full migrate() chain on :memory:, assert version=19 + all columns; re-run = idempotent;
  simulate version-reset re-run. Document clean-machine setup. [P0]

### U3. Identity / responsibility key  — `cluster·role·work-unit`
Live ✅ · Unit 🟡 · Integ ❌ · Det. ✅ · Hard ✅ · Doc 🟡
- The keystone concept (survives resume). Well-reasoned in transcripts, thinly documented as a concept.
- TODO: glossary entry (task #10); confirm identityDir derivation is the single source. [P1]

### U4. Work-unit key  — `pr:repo#n | gus:W | sid:x`
Live ✅ · Unit ✅ · Integ ❌ · Det. ✅ · Hard 🟡 · Doc ✅ — DONE: 6 copies → 1 home (spawn-contract workUnitKey/workUnitPath), inbox-path drift fixed, regression-tested (ADR-0057 consolidation). Remaining: re-key dedup onto the work-unit ENTITY id (0057 deep) + the claim lock (0072).
- **HIGH:** 6 implementations, 2 DRIFTED (resolve-levels.ts:48 filesystem-safe `-` form; start-actions.ts:36
  no-prefix form) — they CANNOT join against each other → inbox-routing / identity mismatch.
- TODO: one canonical `workUnitKey()` in spawn-contract.ts; inline the 4 dupes; rename the fs-safe one
  `workUnitOfForPath()`; shape-contract test. [P0]

### U5. Liveness (cmux bridge)  — `src/cmux/bridge.ts`, `live.ts`, `liveness.ts`
Live ✅ (proven this session) · Unit ✅ (bridge, fixtures) · Integ ❌ · Det. ✅ · Hard ✅ · Doc ✅ (ADR-0054)
- Rewritten for cmux 0.64 hook store; store∩tree intersection; readable flag. bridge/liveness tested;
  live.ts I/O path (execFileSync/readFileSync/JSON.parse) has NO test.
- TODO: stub execFileSync→liveBridge().readable=false; missing-store=readable-but-empty. Fixtures could
  drift from real cmux (static). [P1]

### U6. Spawn primitive  — `src/resume/spawn-cmux.ts`
Live ✅ (scout resume this session) · Unit ✅ (argv construction + JSON/regex ref parse) · Integ ❌ · Det. ✅ · Hard ✅ (timeout:10000 added) · Doc ✅ — hardened this arc.
- **HIGH:** zero tests on the ONE spawn primitive. new-workspace ref via bare regex; Bun.spawnSync has
  NO explicit timeout. No-scrub fix (ADR-0054/0042) was a live experiment, not a test.
- TODO: mock spawnSync, assert argv shape + focus flag; add `timeout: 10000`; JSON-first ref parse. [P0]

### U7. Resume — single session  — `src/resume/resume-session.ts`
Live ✅ (proven, idempotent) · Unit ✅ · Integ ❌ · Det. ✅ · Hard ✅ (fail-closed) · Doc ✅
- Solid. Fail-closed abort proven live this session. Integration (mint→spawn→bind→see-open) still manual.
- TODO: end-to-end resume test (stubbed cmux). [P1]

### U8. Resume — cluster / supersede-dedup  — `src/resume/resume-cluster.ts`
Live ✅ · Unit ✅ (plan logic) · Integ ❌ · Det. ✅ · Hard ✅ (abortedUnreadable) · Doc ✅
- planClusterMembers tested; the fan-out (spawn loop) untested — could spawn superseded members if broken.
- TODO: 2 rows same PR (1 live/1 dead) → only dead superseded, not spawned. [P1]

### U9. Spawn contract (one-embodiment + correct-worktree)  — `src/catalogue/spawn-contract.ts`, `new-session.ts`
Live ✅ · Unit ✅ (predicates) · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡
- **TOCTOU (D1):** gap between liveness check (new-session.ts:327) and spawn (~line 288) — two concurrent
  spawns for one PR both pass. Live work-unit gathering + git-worktree probe untested (could spawn on main).
- TODO: optimistic re-check on updated_at OR lock file per work-unit; one-embodiment integration test. [P0/P1]

### U10. Hook resolution + merge  — `src/hooks/resolve-*.ts`, `merge.ts`
Live ✅ · Unit ✅ (69 tests) · Integ 🟡 · Det. ✅ · Hard ✅ · Doc 🟡
- Strong: pure, deterministic, lint-clean (30 files). Full pipeline (resolve→read→merge→inject) + format-
  collision + degraded-flag paths are code-walked not test-walked.
- TODO: temp .ccs-hooks tree integration test; collision-error test. [P1]

### U11. Hook types (per type)  — claude-md · start · stop · meta-update · cmux-paint · statusline · spawn-location · guard
Live 🟡 · Unit ✅ · Integ ❌ · Det. ✅ · Hard 🟡 · Doc 🟡
- **CRITICAL (found):** SessionStart & Stop are DOUBLE-REGISTERED in ~/.claude/settings.json → every hook
  fires 2×. **MEDIUM:** legacy worker-stop-hook.sh coexists with new TS stop hook → racing phase writes
  via different detection. phase-rubric injects only at Stop (turn-1 gap). `guard` declared, no handler.
- TODO: de-dupe settings.json; retire/merge legacy stop hook; decide phase-rubric SessionStart injection;
  document guard as future or remove. [P0 for de-dup, P1 rest]

### U12. Tab painting / sync-tabs  — `src/catalogue/sync-tabs.ts`
Live ✅ (selector-driven, verified) · Unit 🟡 · Integ ❌ · Det. 🟡 · Hard 🟡 (best-effort, no retry) · Doc ✅ — DONE: `ccs sync-tabs <selector>` shares S18 with resume, plural loops the single-paint primitive (ADR-0056).
- Paint race (refOverride) + config overlay untested; ops fail silently with no retry.
- TODO: assert resume passes refOverride; add 2×/500ms retry; render→push handoff test. [P1/P2]

### U13. Statusline  — `src/catalogue/render-statusline.ts`, statusline hook
Live ✅ · Unit ✅ (render) · Integ ❌ · Det. ✅ · Hard 🟡 · Doc 🟡
- Global self-filtering command; shares phase vocab with renderTab. statusline hook type currently unused
  (no config files).
- TODO: confirm worker vs non-worker fallback live; doc the vocabulary. [P1]

### U14. Inbox (deliver + wake)  — `src/inbox/`
Live ✅ · Unit ✅ (planBump) · Integ ❌ · Det. ✅ · Hard ✅ (durable, wake best-effort) · Doc 🟡
- Deliver-always + wake-if-live. Correct design. send/send-key delivery unconfirmed (durable inbox covers).
- TODO: doc the deliver-vs-wake contract in runbook. [P2]

### U15. State store / mergeFields  — `src/state/store.ts`
Live ✅ · Unit ✅ · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡
- **D3:** read-modify-write with no lock. Mitigated by single-writer-per-field convention (ADR-0031); breaks
  silently if two roles write one field.
- TODO: `ccs state lint` (flag >1 writer per file) + document contract. Lock only if a real multi-writer appears. [P2]

### U16. Grouping / epic  — `src/state/groupings.ts`, `grouping-command.ts`
Live ✅ · Unit ✅ · Integ ❌ · Det. ✅ · Hard 🟡 · Doc ❌
- Epic ENTITY (sensor-written) vs epic gotchas (human-authored) — different sources, confusing layout.
  Epic mojibake was stored-data (bad GUS encoding), not renderer. Rename epic→grouping deferred (ADR-0051).
- TODO: doc the two sources; decide rename. [P2]

### U17. Selector resolution  — `src/resume/selector.ts`
Live ✅ · Unit ✅ · Integ ❌ · Det. ✅ · Hard 🟡 · Doc ❌
- id | #pr | owner/repo#pr | W-num | epic | role | cluster. Untracked new file — confirm no dangle.
- TODO: document the syntax in `ccs resume` help. [P2]

### U18. Inference engine (codex/claude)  — `src/inference/` (new)
Live 🟡 · Unit 🟡 (happy path) · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡 (ADR-0055)
- Pluggable engine, new. Timeout/unparseable-response edges untested.
- TODO: arg-shape tests per engine; failure-mode tests. [P1]

### U19. CLI surface / ergonomics  — `src/cli.ts`
Live ✅ · Unit 🟡 · Integ ❌ · Det. ✅ · Hard 🟡 · Doc ❌
- **Found:** 5 commands (role, resume-command, gus-work, epic, phase) + `hooks` + `grouping` MISSING from
  HELP; new-session has 6 undocumented flags; ls/tree/cluster/sync-roles flags undocumented. `roles rm` deletes
  homeDir with NO confirmation. Exit codes inconsistent (2 vs 1). Silent no-op: sync-tabs returns 0 when skipped.
- TODO: fill HELP; add roles-rm confirmation/--force; unify exit codes; per-command --help for complex cmds. [P1]

### U20. TUI  — `src/tui/`
Live ✅ · Unit ✅ · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc ❌
- Ink-based. Tests wrap on 80-col (assert stable footer token). openSessionTitles had serial-blocking (cached).
- TODO: keep async-only probes on render path; smoke-test live. [P2]

### U21. cmux integration surface (version + parsing)  — `src/cmux/`, `spawn-cmux.ts`, `open-state.ts`
Live ✅ · Unit 🟡 · Integ ❌ · Det. 🟡 · Hard ❌ · Doc 🟡
- **P0:** NO cmux version guard (0.64.17 installed; nothing pins/checks it) — a cmux upgrade re-breaks liveness
  silently. Hook-store path hardcoded. **LEGACY fail-OPEN path** (open-state.ts title-join) still present = the
  remaining duplicate-spawn vector. 11 subcommands / 22 call sites mapped.
- TODO: cmuxVersion() guard (task #6); CMUX_HOOK_STORE_PATH override; retire open-state.ts legacy path;
  traced-exec wrapper for errors/latency. [P0]

---

## LAYER 2 — pr-watch cluster

### U22. control role (loop)  — the actor/sensor
Live ✅ · Unit — · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡
- Senses board/PRs/CI, routes, advances, owns lifecycle. Primary sensor (scout supplements). Never resumes cluster.
- TODO: live tick verification; doc in cluster runbook (#16). [P1]

### U23. concierge role  — liaison to Milad
Live ✅ · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡
- Only role that talks to Milad; dual-relays (worker for speed, control for ledger). Judges WHEN to surface.
- TODO: live verification of surfacing logic; doc. [P1]

### U24. slack-scout role  — Slack sensor
Live ✅ (resumed this session) · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡
- Reads Slack, classifies, routes to inboxes. Never posts. Classification-precedence spec lived in transcript —
  confirm it made it into the skill.
- TODO: verify classification precedence documented; live routing test. [P1]

### U25. eval role  — outside observer
Live ✅ · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡
- Grades the loop from transcripts; proposes, never acts. loop_status.py had only eval to write when tested.
- TODO: confirm grade pill populates live. [P1]

### U26. pr-agent role (worker)  — owns ONE PR
Live ✅ · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡
- Reports phase/result; receives steers. Launch footgun: hangs on prompts unless acceptEdits. Worktree-local
  statusline needed (inline --settings doesn't load global).
- TODO: full worker lifecycle live (see U28); doc launch mode. [P0 — core flow]

### U27. designer role  — this role
Live ✅ · Integ — · Det. — · Hard — · Doc 🟡
- Not in live PR flow; produces ADRs/specs. Runs at home cwd (ADR-0052).

### U28. Phase state machine (stage × activity)  — `roles/pr-agent/docs/phase-state-machine.md`
Live ❌ (BUILT, untested live) · Unit ✅ (commands) · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc ✅
- stage: building→milad-review→in-review→approved→merged (monotonic, engine-latched); activity: dormant/
  needs-you/fixing. `ccs ready` latches, `ccs approve` advances.
- TODO: on a LIVE worker — pill shows right stage·activity, ready latches milad-review, approve→in-review,
  needs-you/fixing overlay, turn-end rubric appears in worker context. [P0]

### U29. The gate  — internal review AND Milad review before public
Live 🟡 · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡
- Constitutional invariant. Needs live confirmation it actually holds.
- TODO: verify a PR can't reach public review without clearing both. [P1]

### U30. Lifecycle marks  — `ccs mark` (control-owned)
Live ✅ · Unit ✅ · Integ ❌ · Det. ✅ · Hard 🟡 · Doc 🟡
- Workers never self-complete; control marks off sensed merge+deploy. retired-skip in resume tested.
- TODO: doc the lifecycle ownership rule. [P1]

### U31. Board/gate/pending sensing  — engine + !-injection
Live ✅ · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡
- sense.sh --keep --write every tick → pending.json always fresh (fix for 7→14-events-no-drains bug). Repointed
  to ~/.ccs/cache (ADR-0049). External-sensor-driven, not session-remembered.
- TODO: verify freshness live; doc the always-read surfaces. [P1]

### U32. catalogue_sync engine  — `engine/scripts/catalogue_sync.py`
Live ✅ · Unit ❌ · Integ ❌ · Det. 🟡 · Hard 🟡 · Doc 🟡
- Python sensor: git/GitHub → pr_state/pr_head_sha; writes epic entity from GUS. Placeholder→real PR key
  migration (#36) deferred.
- TODO: key-migration; sensor test harness. [P2]

---

## Cross-cutting invariants (prove these hold across units)
- **CI-1 Determinism:** ✅ D2 FIXED — lineage.ts sort now has a stable sessionId tie-break (regression-tested). Same row+config → same behavior (ADR-0045).
- **CI-2 Fail-closed everywhere it spawns:** resume ✅; legacy open-state.ts fail-OPEN path ✅ DELETED (ADR-0067). Closed.
- **CI-3 No duplicate embodiment:** work-unit key drift ✅ FIXED (U4); still open: spawn TOCTOU (U9→0072 claim lock) + completeness cross-check (task #9, runbook-only). [P1]
- **CI-4 Runtime state under ~/.ccs, never cwd-relative** (ADR-0041): ✅ honored; $HOME-before-homedir fix VERIFIED landed (paths.ts:14 `process.env.HOME ?? homedir()`).
- **CI-5 Hooks fire once, in the right role/cwd:** still BLOCKED by SessionStart/Stop double-registration in settings.json (U11, task #33). [P0]

---

## Suggested burn-down order
1. **P0 correctness cluster:** U4 (work-unit key), U2 (migrations test), U6 (spawn timeout+tests), U11 (hook
   de-dup), U21 (cmux version guard + retire legacy path), CI-1 (D2 tie-break), U9 (TOCTOU).
2. **P0 flow proof:** U28 + U26 + U29 — stand up a worker, drive the phase machine live (task #7).
3. **P1 confidence:** integration tests (U1/U5/U7/U8/U10), CLI help (U19), role live-checks (U22–U25, U30, U31).
4. **P2 polish:** state lint (U15), docs (U16/U17/U20), sensor tests (U32).
</content>
</invoke>
