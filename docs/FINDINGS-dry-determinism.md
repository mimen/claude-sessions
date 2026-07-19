# Findings: duplication & determinism audit (agent a514f14d)

Read-only audit of /Users/mimen/projects/claude-sessions. All findings verified against source.

## 1. WORK-UNIT KEY DUPLICATION — HIGH (6 implementations, 2 drifted)

Work-unit key logic (`pr:repo#num`, `gus:W-xxx`, `sid:xxx`) implemented 6×:

1. `spawn-contract.ts:23` — `spawnWorkUnit()` → `pr:${prRepo}#${prNumber}` | `gus:${gusWork}` | null
2. `spawn-contract.ts:30` — `rowWorkUnit()` → same shape
3. `resume-cluster.ts:36` — `workUnit()` → adds `sid:${sessionId}` fallback (never null)
4. `cluster-map.ts:134` — `unitKey()` → `sid:` fallback (never null)
5. `resolve-levels.ts:48` — `workUnitOf()` → **DRIFTED**: `${seg(prRepo)}-${prNumber}` | `seg(gusWork)` |
   null. Filesystem-safe (no `:`/`#`); CANNOT join against #1-4.
6. `start-actions.ts:36` — `responsibilityOf()` workUnit field → **DRIFTED**: `${prRepo}-${prNumber}` |
   `gusWork`, no prefix, plain hyphen. CANNOT join against #1-4.

**Drift:** #1-4 consistent (differ only null-vs-sid). #5 fs-safe form, #6 no-prefix form — neither
joins the canonical form.

**Failure scenarios:**
- Identity mismatch: `workUnitOf()` (#5) key won't find sessions keyed by `rowWorkUnit()` (#2) —
  `engineai-goose-12345` ≠ `pr:engineai/goose#12345`.
- Silent divergence: a fix to one copy (e.g. prNumber=0 handling) misses the other five.
- Inbox routing breaks: start-actions (#6) locates inbox with plain-hyphen form; identity resolver
  (#5) uses sanitized form → paths don't match.

**Fix (canonical home = spawn-contract.ts, the born-correct layer, ADR-0047):** promote `rowWorkUnit()`
to single source; add `workUnitKey(prRepo,prNumber,gusWork,sessionId)` (never-null variant) that #3/#4
call; inline the dupes; rename #5 → `workUnitOfForPath()` (fs-safe, not for joins); one shape-contract
test. **Effort: M (4-6h).**

## 2. SPAWN TOCTOU RACE (D1) — MED-HIGH

`new-session.ts:234-238` and `320-352`: one-embodiment check reads liveness at line 327
(`openSessionIds()`), builds live-units set (331-337), checks at 352, then spawns ~10-50 lines later
(mint id 242, spawn 288). **No lock / atomic test-and-set** between check and spawn. Parallel path in
`resume-session.ts:41-81` (check 41, spawn 103) shares one bridge snapshot per resumeMany() call.

**Failure scenario:** Terminal A and B both run `ccs new-session --pr-number 12345 --pr-repo foo/bar`
within ms → both read "not live" → both pass contract → both write rows + spawn cmux → two live
sessions for `pr:foo/bar#12345`. Supersede-dedup retires one LATER, but both run until next resume.
Real trigger: CI launching parallel workers for one PR.

**Fix:** Option A (optimistic lock via catalogue updated_at re-check, 3-4h) or Option B (lock file per
work-unit, 6-8h). **Effort: M.**

## 3. LINEAGE TIE-BREAK NONDETERMINISM (D2) — LOW-MED

`lineage.ts:68-73`: sort returns `0` when both `lastTs` are null → JS sort not stable on equality →
order flips between runtimes/versions. (resume-cluster.ts:72-76 is OK — has `a.i - b.i` input-order
tie-break.)

**Failure scenario:** two same-PR embodiments both `lastTs=null` → Node 20 orders [A,B], Bun/Node22
orders [B,A] → nondeterministic transcript replay order, violates ADR-0045.

**Fix:** add `return a.sessionId.localeCompare(b.sessionId)` final tie-break. **Effort: S (5 min + 1 test).**

## 4. MERGEFIELDS READ-MODIFY-WRITE WITHOUT LOCK (D3) — LOW

`store.ts:93-101`: read (98) → merge (99) → writeDoc (100). writeDoc is atomic (temp+rename) but two
concurrent mergeFields() both read old doc, last write clobbers the other's fields.

**Mitigated by** single-writer-per-field convention (ADR-0031) — disjoint fields = clobber is a no-op.
Breaks only if two roles write the SAME field concurrently (silent lost update).

**Fix:** Option C recommended — `ccs state lint` (flag files written by >1 role) + document contract.
Lock only if a real multi-writer case appears. **Effort: S (1-2h).**

## 5. OTHER DUPLICATION — assessed, no action
- JSON.parse (40+ sites): context-specific I/O boundaries, no shared logic. Fine.
- cmux invocation (18 execFileSync + 2 spawnSync): already centralized (live.ts liveness, spawn-cmux.ts
  spawn); tab-paint scattered but each a distinct op. Fine.
- Validation: `validateSpawn()` single site; spawn-contract centralized. Fine.

## Summary
| # | Issue | Severity | File:Line | Effort | Priority |
|---|-------|----------|-----------|--------|----------|
| 1 | Work-unit key dup (6 copies, 2 drifted) | HIGH | spawn-contract.ts:23,30 +4 | M | P0 |
| 2 | Spawn TOCTOU | MED-HIGH | new-session.ts:234-352, resume-session.ts:41-103 | M | P1 |
| 3 | Lineage tie-break nondeterminism | LOW-MED | lineage.ts:68-73 | S | P1 |
| 4 | mergeFields RMW no lock | LOW | store.ts:93-101 | S | P2 |

D1-D3 from the brief all CONFIRMED real (= issues 2/3/4). Work-unit dup count = 6 (brief said ~6, exact).
