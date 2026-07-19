# Findings: test-coverage-gap analysis (agent a48c1608)

414 tests / 55 test files (~4,960 test LOC). 89 source files (excl. tests).

## Coverage map
| Module | Coverage | Risk |
|--------|----------|------|
| src/cmux/ | bridge ✅ (fixtures), liveness ✅, **live.ts ❌ (0)** | HIGH |
| src/resume/ | resume-session ✅(5), resume-cluster ✅(9), selector ✅, **spawn-cmux ❌, command ❌** | HIGH |
| src/catalogue/ | db accessors ✅(19+), new-session ✅(11), render-tab ✅, **migrations ❌, sync-tabs ❌, commands ❌** | CRITICAL |
| src/hooks/ | merge ✅(15), resolve-config ✅, resolve-levels ✅, **hook-run ❌** | MEDIUM |
| src/index/ | **index ❌, schema ❌** (1 tiny search test) | HIGH |
| src/inference/ | engine 🟡 (happy path) | MEDIUM |
| src/state/ | cluster-state ✅, store ✅, groupings ✅ | LOW |

## Detailed gaps
1. **catalogue/db.ts (693 LOC) — CRITICAL:** migrations v1→v19 ZERO tests; idempotence (hasColumn) untested;
   v14/v15 are DROP TABLE roles/epics guarded only by version; v16-19 (status_line, milad_review,
   build_complete, stage, activity) hand-patched on live db. A broken migration corrupts production catalogue.
2. **resume/spawn-cmux.ts (49 LOC) — HIGH:** ZERO tests on the ONE spawn primitive. No-scrub fix was a live
   experiment, not a test.
3. **cmux/live.ts (62 LOC) — HIGH:** by-design "thin shell", but the actual liveBridge() I/O (execFileSync,
   readFileSync, JSON.parse) and the fail-closed readable-flag path are only stub-tested via resume-session.
4. **catalogue/sync-tabs.ts (195 LOC) — HIGH:** paint race (refOverride) + config overlay untested.
5. **catalogue/commands.ts (555 LOC) — HIGH:** 20+ exported CLI functions, ZERO tests (rename, tag, phase,
   status, approve...).
6. **index/index.ts (444 LOC) — HIGH:** incremental reindex (mtime/size), title COALESCE, cost rollup untested.
7. **catalogue/new-session.ts — MEDIUM:** parseOpts/validateSpawn tested; spawnDetached, checkSpawnContract
   I/O, spawn-location resolution untested.
8. **hooks/resolve-config.ts — MEDIUM:** degraded flag + format-collision paths code-walked not test-walked.
9. **Work-unit supersede/dedup — TESTED ✅** (planClusterMembers), but live work-unit gathering feeding the
   spawn contract is only stub-tested.

## Catastrophic-if-wrong (untested)
1. DB migrations v1→v19 (corrupt catalogue; v14/v15 DROPs).
2. spawnCmux actual spawn (sessions don't spawn / wrong pane).
3. Fail-closed abort under unreadable liveness (would duplicate live sessions).
4. New-session spawn contract one-embodiment (live work-unit gathering untested → dup workers).

## Test-quality issues
1. Stub-heavy resume-session tests would pass even if the real Bridge API changed shape.
2. Static fixtures (tree.json, hook-store.json from 2026-07-09) could drift from real cmux; no edge cases
   (empty windows, stale bindings, detached HEAD).
3. No DB-migration idempotence tests (hasColumn re-run path never exercised).

## Missing integration tests
1. new-session → catalogue row → index row → cmux spawn → liveness.
2. resume → liveness check → spawn/skip → tab paint.
3. cluster resume → supersede dedup → fan-out (fan-out itself untested).
4. catalogue sync → render-tab → cmux push.
5. hook config resolution → merge → injection (full pipeline).

## Prioritized test recommendations
**Tier 1 (CRITICAL):**
1. DB migration chain v1→v19 on :memory: (version=19, all columns, idempotent re-run, version-reset re-run).
2. spawnCmux command construction (mock spawnSync, assert argv shape + focus flag).
3. liveBridge I/O + fail-closed (stub execFileSync throw → readable=false → resume aborts; missing store =
   readable-but-empty).
4. New-session spawn contract one-embodiment (live PR#X → second worker fails; gus-only ≠ PR conflict).

**Tier 2 (HIGH):**
5. Index incremental reindex (write→row, change→update, delete→remove).
6. Resume-cluster fan-out supersede (2 rows same PR, 1 live/1 dead → only 1 resumed).
7. Catalogue commands rename + cmux push.
8. Hook format-collision error (.md + .json → error).

**Tier 3 (MEDIUM):** spawn-location resolution; inference engine edge cases (timeout, unparseable).

## Verdict
Add Tier 1 before production (migration chain, spawnCmux, liveBridge I/O, spawn contract). Tier 2/3 can
follow.
