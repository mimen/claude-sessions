# CCS Codebase Production-Readiness Audit

**Repository**: `/Users/mimen/projects/claude-sessions`  
**Language**: TypeScript (Bun)  
**Files Audited**: 102 non-test source files, 161 total TypeScript files  
**Date**: 2026-07-11

---

## Executive Summary

The codebase is **production-ready** with solid architecture and strong patterns (strict TypeScript, Result type for boundaries, comprehensive tests). Four categories require attention before scaling: **84 dead exports** bloating the API surface, a **catalogue ↔ resume circular dependency**, **inconsistent naming** (system vs cluster, skill vs role), and **67+ silent catch blocks** that mask failures where they should fail-closed.

---

## 1. DEAD / ORPHANED CODE

### 1.1 Dead Type Exports (61 findings) — PRIORITY: MEDIUM

**Issue**: 61 exported types/interfaces are never imported outside their defining file. This bloats the perceived public API and creates confusion about what's actually part of the contract.

**Most Impactful**:

| File | Line | Export | Category | Why It Matters |
|------|------|--------|----------|----------------|
| `src/inference/engine.ts` | 176 | `EngineSelection` | High | Core inference type, appears unused but likely needed by TUI |
| `src/hooks/hook-types.ts` | 20-28 | `FiresOn`, `HookTypeDef` | High | Hook system core types, unclear if part of plugin API |
| `src/resume/resume-session.ts` | 21-25 | `ResumeMeta`, `ResumePlan` | High | Resume planner internals leaked to public API |
| `src/catalogue/cluster-map.ts` | 16-29 | `ClusterMember`, `ClusterMap` | High | Cluster view types, might be TUI contract |
| `src/hooks/merge.ts` | 18-119 | 8 layer types | Medium | Hook merge internals (SectionOp, ClaudeMdLayer, FieldsLayer, etc.) |
| `src/cost.ts` | 90 | `UsageAccumulator` | Medium | Cost tracking internal |
| `src/inbox/inbox.ts` | 26 | `InboxMessage` | Medium | Inbox contract, might be needed for extensions |
| `src/cmux/bridge.ts` | 75 | `SurfaceSession` | Low | Internal cmux bridge type |

**TUI Module (12 dead types)**: `src/tui/` exports many view context types (`ClusterViewCtx`, `EpicViewCtx`, `StateGroupCtx`, `TreeCtx`, `GroupsCtx`) that are never imported — likely internal React state shapes that shouldn't be exported.

**Hooks Module (19 dead types)**: The entire layered hook system exports its internals (`SectionOp`, `ClaudeMdLayer`, `FieldsLayer`, `ActionsLayer`, `GuardLayer`, `FieldSource`, `MetaField`, etc.) — these are merge/resolve implementation details.

**Recommendation**: 
- **S effort**: Review each type — if truly internal, remove `export`
- **M effort**: For types that might be extension points (hooks, inbox), document as `@internal` or move to a `/types` barrel
- **Impact**: Clarifies public API surface, reduces cognitive load for new contributors

---

### 1.2 Dead Function/Const Exports (23 findings) — PRIORITY: HIGH

**Critical Findings**:

| File:Line | Export | Usage | Impact | Effort |
|-----------|--------|-------|--------|--------|
| `src/inference/engine.ts:35` | `binaryExists` | Never imported | Utility exposed unnecessarily | S |
| `src/inference/engine.ts:57` | `createCodexEngine` | Never imported | Engine factory internals leaked | S |
| `src/inference/engine.ts:112` | `createClaudeEngine` | Never imported | Engine factory internals leaked | S |
| `src/inference/engine.ts:172` | `detectAvailable` | Never imported | Engine selection logic exposed | S |
| `src/resume/resume-session.ts:98` | `executeResumePlan` | Never imported | Resume planner internal split wrong | M |
| `src/resume/target.ts:12` | `cmuxReachable` | Never imported | Dead liveness check? | S |
| `src/pr-sense/pr-sense.ts:24` | `sensePrFacts` | Never imported | **ENTIRE MODULE DEAD?** | M |
| `src/cost.ts:96` | `emptyUsageTotals` | Never imported | Cost tracking unused | S |
| `src/paths.ts:17` | `DATA_DIR` | Never imported | Legacy path constant | S |

**Why This Matters**: 
- `executeResumePlan` exported but never called suggests the resume flow might have a dead branch or the planner was refactored and this is orphaned
- `sensePrFacts` never imported means either (a) the entire pr-sense module is dead, or (b) it's only called via dynamic dispatch — both are code smells
- The inference engine exposes all its factory internals when only `buildEngine` and `resolveEngine` are actually used

**Recommendation**:
- **IMMEDIATE (S)**: Remove exports for `binaryExists`, `createCodexEngine`, `createClaudeEngine`, `detectAvailable`, `emptyUsageTotals`, `DATA_DIR`
- **INVESTIGATE (M)**: 
  - Trace `sensePrFacts` — if truly unused, delete the module
  - Confirm `executeResumePlan` is actually dead (might be called indirectly) before removing
  - Check `cmuxReachable` git history — was it replaced by the bridge refactor?

---

### 1.3 Dead Constants / Configuration (6 findings) — PRIORITY: LOW

| File:Line | Export | Notes | Effort |
|-----------|--------|-------|--------|
| `src/tui/columns.ts:8` | `STATUS_W` | Column width constant, never used | S |
| `src/tui/skills/SkillsList.tsx:7-9` | `HOME_W`, `CAT_W`, `USAGE_W` | TUI width constants, never referenced | S |
| `src/tui/stateGroups.ts:13` | `SECTIONS` | Section config array, never imported | S |
| `src/hooks/hook-types.ts:40` | `HOOK_TYPES` | Hook registry array, only used internally | S |

**Recommendation**: Make these `const` (not `export const`) if they're file-scoped.

---

### 1.4 Commented-Out Code — NONE FOUND ✓

**Finding**: Systematic scan found **zero multi-line commented code blocks**. All `//` comments are documentation or single-line notes. This is excellent.

---

### 1.5 Dead Files — NONE ✓

**Finding**: All 102 source files are either imported or serve as entry points (`cli.ts`, `App.tsx`). No orphaned modules.

---

## 2. MODULE BOUNDARIES

### 2.1 Circular Dependency: catalogue ↔ resume — PRIORITY: HIGH

**Issue**: `src/catalogue/new-session.ts` imports from `src/resume/`, and `src/resume/` imports from `src/catalogue/`, creating a circular dependency.

**Evidence**:
```
src/catalogue/new-session.ts:24  → import { shellQuote } from "../resume/command.ts"
src/catalogue/new-session.ts:25  → import { spawnCmux } from "../resume/spawn-cmux.ts"

src/resume/resume-session.ts:15  → import { getRow } from "../catalogue/db.ts"
src/resume/resume-cluster.ts:15  → import { sessionsForSystem, getRow, lifecycleOf, CatalogueRow } from "../catalogue/db.ts"
src/resume/selector.ts:10        → import { sessionsForSystem, sessionsForRole, ... } from "../catalogue/db.ts"
```

**Why This Matters (Production)**:
- **Refactoring risk**: Changes in either module can cascade unpredictably
- **Testing brittleness**: Mocking becomes ambiguous (which module's mock wins?)
- **Build tool fragility**: Some bundlers / tree-shakers choke on cycles
- **Mental model**: Violates "catalogue = data, resume = orchestration" boundary

**Root Cause**: `new-session.ts` is misplaced. It's a **spawn orchestrator** (mints id → writes catalogue → launches cmux), not a catalogue query. It belongs in `/resume` or a new `/spawn` module.

**Recommendation** (M effort):
1. **Move** `src/catalogue/new-session.ts` → `src/resume/new-session.ts` (or `src/spawn/`)
2. **Extract** `shellQuote` to `src/resume/command.ts` if needed by multiple resume flows
3. **Test**: Confirm no import cycles with `madge` or similar: `bunx madge --circular src/`

**Alternative** (L effort if new-session must stay):
- Split `new-session.ts` into two phases:
  - `catalogue/reserve-session.ts` (mints id, writes row, NO resume imports)
  - `resume/launch-session.ts` (calls reserve, then spawns — OK to import catalogue)

---

### 2.2 cmux/ Module Boundary — CLEAN ✓

**Finding**: The `cmux/` bridge abstraction is **well-bounded**:
- `bridge.ts` (pure parsing) → `live.ts` (I/O wrapper) → `liveness.ts` (query API)
- Only 11 files import from `cmux/`, all at the `liveness.ts` API surface (no reaching into bridge internals)
- **ADR-0054 fail-closed contract** properly enforced: `readable` flag distinguishes "nothing open" from "can't tell"

**Praise**: This is a model boundary — pure logic + I/O wrapper + public API.

---

### 2.3 hooks/ Module — Boundary Unclear (M impact)

**Issue**: The `hooks/` module exports 60+ symbols but has no clear contract. It mixes:
- Resolution logic (`resolve-config.ts`, `resolve-levels.ts`)
- Merge combinators (`merge.ts`)
- Hook execution (`hook-run.ts`)
- Registration (`register.ts`)
- Commands (`hooks-command.ts`, `statusline-command.ts`, `worker-stop-command.ts`)

**Why This Matters**:
- A new contributor doesn't know where to start when "adding a hook type"
- The 19 dead type exports (see 1.1) suggest internals are leaking
- No clear entry point: is it `hookRunCommand`? `registerSessionCommand`? Both?

**Recommendation** (L effort):
- Document the hook pipeline in `hooks/README.md`: resolve → read → merge → execute
- Mark internal types with `@internal` JSDoc or move to `hooks/internal/`
- Consider splitting into subdirs: `hooks/resolve/`, `hooks/merge/`, `hooks/execute/`, `hooks/commands/`

---

### 2.4 catalogue/ DB Access — Leaky Abstraction (M impact)

**Issue**: `catalogue/db.ts` exports **42 functions**, mixing:
- Low-level mutations (`setRole`, `setSystem`, `setResumeId`, ...)
- High-level queries (`sessionsForRole`, `sessionsForSystem`, ...)
- Schema migrations (`migrate`, `hasColumn`)
- Lifecycle helpers (`lifecycleOf`, `describePrState`)

**Why This Matters**:
- Callers can bypass the command layer (`commands.ts`) and mutate directly, creating inconsistent state
- The mutation surface is wide (42 exports) → hard to audit for ACID violations
- No clear "command vs query" split (CQRS-style)

**Recommendation** (M effort):
1. **Split** `db.ts`:
   - `db-schema.ts` (migrations, types, openCatalogue)
   - `db-queries.ts` (read-only: sessionsFor*, getRow, lifecycleOf)
   - `db-mutations.ts` (write: set*, stamp*)
2. **Restrict** mutation imports to `commands.ts` only (enforce via linter or convention doc)
3. **Add** a `transaction` helper if multiple mutations need ACID guarantees

---

## 3. NAMING CONSISTENCY

### 3.1 system vs cluster — CRITICAL INCONSISTENCY

**Issue**: The codebase uses `system` (schema) and `cluster` (UI/docs) **interchangeably** for the same concept.

**Evidence**:

| Location | Term | Context |
|----------|------|---------|
| `catalogue/db.ts:42` | `system: string \| null` | **Schema column** |
| `catalogue/db.ts` | `sessionsForSystem(db, slug)` | Query function name |
| `cli.ts:64` | `ccs cluster <system>` | **Help text uses BOTH** |
| `cli.ts:419` | `function clusterView(systemSlug, ...)` | Function name mixes both |
| `resume/resume-cluster.ts:12` | `"cluster" is the public word; members resolve via the \`system\` column` | **Explicit admission of split** |
| `resume/selector.ts:78` | `isCluster(db, token)` calls `sessionsForSystem` | Function name = cluster, impl = system |
| `tui/clusterView.ts:131` | `header(\`cluster:${system}\`, ...)` | Variable named `system`, UI says "cluster" |

**Why This Matters (Production)**:
- **Onboarding friction**: New dev sees "cluster" in help text, searches codebase, finds `sessionsForSystem` and gets confused
- **Bug surface**: A refactor might rename one but not the other, breaking queries
- **Documentation rot**: ADRs say "cluster", schema says "system" — which is authoritative?

**Root Cause**: The schema was written before the "cluster" term was finalized (per ADR-0037, which post-hoc declares `system` is the column for clusters).

**Recommendation** (M effort):
1. **Pick ONE term** for production:
   - **Option A** (least churn): Keep schema as `system`, rename all user-facing occurrences (help text, TUI labels, variable names) to `system`
   - **Option B** (clean break): Migrate schema `system` → `cluster` (additive migration, backfill, then mark `system` deprecated)
2. **Enforce**: Lint rule or convention doc: "schema column = `system`, UI/logs = `cluster`" OR "everywhere = `cluster`"
3. **Timeline**: M effort = ~2 days (schema migration + 30+ file renames + tests)

**Recommended Choice**: **Option A** (keep `system` everywhere). Reason: "cluster" is domain jargon (Milad's PR-watch fleet); `system` is more general (any grouped operation).

---

### 3.2 role vs skill — DEPRECATED BUT STILL PRESENT

**Issue**: The schema has both `role` and `skill` columns, with `skill` marked DEPRECATED (ADR-0015).

**Evidence**:
```typescript
src/catalogue/db.ts:29-34
  skill: string | null;  // DEPRECATED (ADR-0015)
  role: string | null;   // Replaces `skill`. Reads fall back to `skill` when unset.
```

**Current State**:
- Reads use `role ?? skill` fallback (line 344)
- One-time backfill ran: `UPDATE catalogue SET role = skill WHERE role IS NULL` (line 244)
- `skill` column still in schema (additive-only migration policy)

**Why This Matters**:
- **Confusion**: New code might use `skill` not realizing it's deprecated
- **Data drift**: If `skill` is ever written to (old tool version, manual SQL), it's silently ignored
- **Schema bloat**: Dead column taking space + mental overhead

**Recommendation** (L effort, LOW PRIORITY):
1. **Document** in `db.ts` header: "`skill` is a ghost column (kept for migration safety, never write to it)"
2. **Add** a check in `commands.ts` to error if anyone tries to set `skill`
3. **Future**: After 6+ months of `role` in prod, hard-deprecate `skill` (make reads error if it's set)

**No immediate action needed** — this is managed debt, properly documented.

---

### 3.3 session vs identity vs responsibility — OVERLOADED

**Issue**: Three overlapping concepts:
- **session** = a Claude Code process (has a `sessionId`)
- **identity** = the durable agent key (role + cluster + epic + work-unit)
- **responsibility** = the structured identity key (see `inbox/identity-path.ts:22`)

**Evidence**:
- `inbox/identity-path.ts:41` has `function identityDir(root, r: Responsibility)`
- `catalogue/lineage.ts:19` has `function identityKey(row: CatalogueRow)`
- `catalogue/db.ts:407` has `function identityKeyOf(row: CatalogueRow | null)`
- `src/hooks/resolve-levels.ts:21` has `type Level = "user" | "cluster" | "role" | "epic" | "work-unit" | "identity"`

**Why This Matters**:
- "identity" is used both for the concept (durable key) AND as a Level in the hook system
- "responsibility" is the interface name but never appears in prose/docs
- Code says `identityDir(r: Responsibility)` but docs say "identity's inbox" — which is it?

**Recommendation** (M effort):
1. **Standardize** on `Responsibility` as the TYPE name (it's already the interface)
2. **Use** "identity" as the USER-FACING term (docs, logs, help text)
3. **Rename** `identityDir` → `responsibilityDir` OR keep `identityDir` and add a comment: `/** Runtime dir for an identity (Responsibility) */`
4. **Audit** hook levels: does "identity" level mean "responsibility-scoped config"? If yes, document it.

**Verdict**: This is **tolerable** (the code works), but **risky** for new contributors. M effort to align.

---

### 3.4 Minor Naming Nits (LOW PRIORITY)

- `src/catalogue/open-state.ts` has deprecated functions (`openSessionTitles`, `cmuxWorkspaceForSession`) that still exist but are never called — should be removed or marked `@deprecated`
- `src/resume/target.ts` defines `ResumeTarget` and `TargetPin` types (both dead exports) — likely leftover from a refactor
- `src/index/index.ts` has `reindexStore` (main entry point) and `reindex` (appears to be a lower-level helper) — consider renaming for clarity

---

## 4. ERROR HANDLING

### 4.1 Silent catch Blocks — 67+ FINDINGS (CRITICAL)

**Issue**: 67+ `catch {}` blocks that silently swallow errors, masking failures where the system should fail-closed.

**Critical Findings** (fail-open where should fail-closed):

| File:Line | Code | Why It's Dangerous | Fix | Effort |
|-----------|------|-------------------|-----|--------|
| `src/cmux/live.ts:39-41` | `catch { return { tree: {}, ok: false } }` | **FAIL-CLOSED CORRECTLY** ✓ | None (good pattern) | - |
| `src/cmux/live.ts:52-53` | `catch { return { store: {}, ok: false } }` | **FAIL-CLOSED CORRECTLY** ✓ | None (good pattern) | - |
| `src/resume/selector.ts:126-128` | `try { indexedId = sessionById(...) } catch { indexedId = null }` | Index lookup failure → treats id as valid anyway. **Comment says this is intentional** (just-minted sessions). | Add comment: `// Index miss is OK — just-minted session` | S |
| `src/inference/engine.ts:97-98` | `catch { return null }` | Inference engine failure returns null (LLM call failed) | **ACCEPTABLE** (inference is best-effort) | - |
| `src/parse.ts:130-131` | `catch { continue; }` | Corrupt transcript line skipped | **ACCEPTABLE** (streaming parse, partial data OK) | - |
| `src/resume/locate.ts:49` | `catch { return { kind: "absent" } }` | Storage folder read failure → treats as "not found" | **RISKY**: disk error looks like "no session". Should distinguish "can't tell" vs "not found" | M |
| `src/resume/locate.ts:78` | `catch { return null }` | Same issue — can't distinguish error from absence | **RISKY**: caller resumes nothing when it should error | M |
| `src/roles/role-files.ts:41-42` | `catch { toml = {}; }` | **Comment says "fail-open; lint surfaces it"** | Add explicit log: `console.warn("malformed TOML")` | S |
| `src/roles/sync-roles.ts:79-80` | `catch { return { kind: "absent" } }` | `lstat` failure → treats as absent | **RISKY**: permission error looks like "file doesn't exist" | M |
| `src/state/store.ts:66, 72, 109` | `catch { return ... }` | State store read failures silently return defaults | **FAIL-OPEN**: corrupted state file is silently ignored, should error or log | M |
| `src/hooks/register-command.ts:23, 75, 79` | `catch { ... }` | Hook registration failures swallowed | **RISKY**: session starts with broken hooks, no signal | M |

**Pattern Analysis**:
- **Good fail-closed**: `cmux/live.ts` (explicitly returns `ok: false`)
- **Acceptable fail-open**: Inference engine, transcript parsing (streaming/best-effort)
- **Risky fail-open**: File I/O (can't distinguish error from absence), state store, hook registration

**Why This Matters (Production)**:
- **Silent degradation**: Session starts with broken hooks, user never knows
- **Data loss**: Corrupted state file is ignored → in-flight work disappears
- **Debugging nightmare**: "Why didn't my session resume?" → turns out liveness check hit a disk error, returned "not found"
- **Security**: Permission errors (EACCES) treated as "file doesn't exist" can mask intrusions

**Recommendation** (M-L effort):
1. **IMMEDIATE (M)**: Add error logging to ALL catch blocks in:
   - `src/resume/locate.ts` (can't tell if session is missing vs disk error)
   - `src/state/store.ts` (corrupted state should log + degrade, not silently reset)
   - `src/hooks/register-command.ts` (broken hook should error, not start session)
2. **PATTERN (L)**: Introduce a `tryOrLog` helper:
   ```typescript
   function tryOrLog<T>(fn: () => T, fallback: T, ctx: string): T {
     try { return fn(); }
     catch (e) { console.warn(`${ctx} failed:`, e); return fallback; }
   }
   ```
   Use it in all "fail-open" paths so errors are at least visible in logs.
3. **AUDIT (L)**: Review each of the 67 catch blocks and classify:
   - ✓ Acceptable (inference, parse)
   - ⚠ Log needed (I/O, state)
   - ❌ Must fail-closed (liveness, hook registration)

---

### 4.2 Result<T> Usage — INCONSISTENT

**Issue**: The codebase has a `Result<T>` type (`src/result.ts`) but only 4 functions use it.

**Current Result Users**:
- `src/config.ts:69` — `loadConfig(): Result<Config>`
- `src/store.ts:20` — `scanStore(): Result<StoredSessionFile[]>`
- `src/skills/scan.ts:127` — `discoverSkills(): Result<SkillRecord[]>`
- `src/skills/archive.ts:25` — `archiveSkill(): Result<string>`

**Non-Result Functions That Should Use It**:
- `src/cmux/live.ts` — `liveBridge()` returns `Bridge` with a `readable` flag, but callers must check it manually (not type-forced)
- `src/inference/engine.ts` — `runStructured()` returns `unknown | null` (should be `Result<unknown, EngineError>`)
- `src/hooks/resolve-config.ts` — Returns `EffectiveConfig` with a `degraded` flag (not type-forced)
- `src/resume/locate.ts` — `decodeStorageFolder()` returns `{ kind: "absent" }` on error (can't distinguish real absence from read error)

**Why This Matters**:
- **Type safety**: `Result<T>` forces callers to handle errors (`.ok` check); returning `T | null` doesn't
- **Consistency**: Some boundaries use `Result`, most don't — new code doesn't know which pattern to follow

**Recommendation** (L effort, OPTIONAL):
1. **ACCEPT** hybrid model: Result for "config/scan" boundaries, explicit flags elsewhere
2. **OR** adopt Result everywhere: refactor all boundary functions (inference, cmux, hooks, resume/locate) to return `Result<T, E>`
3. **Document** the choice in a PATTERNS.md: "When to use Result vs try/catch vs flags"

**Verdict**: Current state is **workable**. Result usage is consistent within each module (config + store use it; others don't). Only push L effort if you're refactoring error handling globally.

---

### 4.3 Throws — RARE ✓

**Finding**: Only **6 `throw` statements** in 102 source files (grep confirmed). Most are in unreachable paths or validation guards. This is **excellent** — the codebase prefers Result/null returns over exceptions.

---

### 4.4 Error Reporting — console.error vs logging (LOW PRIORITY)

**Finding**: 82 occurrences of `console.error` / `console.warn` / `process.exit` (mostly in `cli.ts` command handlers). No centralized logger.

**Why This Matters**:
- **Production logs**: Console logging goes to stderr, which is fine for CLI but not structured (no log levels, no timestamps, no context)
- **Testing**: Hard to assert on errors in tests (need to mock console)

**Recommendation** (L effort, OPTIONAL):
- Add a simple logger (`src/logger.ts`):
  ```typescript
  export const log = {
    info: (msg: string, ctx?: unknown) => console.log(JSON.stringify({ level: "info", msg, ctx, ts: new Date().toISOString() })),
    warn: (msg: string, ctx?: unknown) => console.warn(JSON.stringify({ level: "warn", msg, ctx, ts: new Date().toISOString() })),
    error: (msg: string, ctx?: unknown) => console.error(JSON.stringify({ level: "error", msg, ctx, ts: new Date().toISOString() })),
  };
  ```
- Replace all `console.*` calls with `log.*`

**Verdict**: **Not urgent** — console logging is fine for a CLI tool. Only needed if you're adding log aggregation / observability.

---

## 5. ADDITIONAL FINDINGS

### 5.1 ADR Drift (LOW PRIORITY)

**Issue**: Comments reference ADRs (e.g. ADR-0015, ADR-0054) but some are inconsistent with the schema.

**Examples**:
- `catalogue/db.ts:29` says `skill` is deprecated per ADR-0015, but ADR-0015 also introduced `role` — the comment doesn't explain the migration path
- `cmux/bridge.ts:1-25` has a long ADR-0054 explanation that duplicates the ADR itself

**Recommendation**: Add a `docs/adr/INDEX.md` linking all ADRs, and shorten in-code references to `// See ADR-0054` (not multi-paragraph recaps).

---

### 5.2 Test Coverage (OUT OF SCOPE, but noted)

**Finding**: 59 `.test.ts` files for 102 source files = **58% test coverage by file count**. Many core modules (catalogue/db, resume/resume-cluster, cmux/bridge, hooks/resolve-config) have tests. TUI modules (src/tui/) are less tested (Ink testing is hard).

**Recommendation**: No immediate action, but flag for future: add integration tests for resume flows.

---

## 6. PRIORITIZED ACTION PLAN

### CRITICAL (Fix Before Production Scale-Up)

1. **[ERROR] Fix fail-open catch blocks** (M effort, 2-3 days)
   - `src/resume/locate.ts:49, 78` — distinguish "not found" from "can't read"
   - `src/state/store.ts:66, 72, 109` — log corrupted state, don't silently reset
   - `src/hooks/register-command.ts:23, 75, 79` — fail hook registration loudly

2. **[ARCH] Break catalogue ↔ resume circular dependency** (M effort, 1-2 days)
   - Move `new-session.ts` to `src/resume/` or `src/spawn/`
   - Verify no import cycles with `bunx madge --circular src/`

3. **[NAMING] Pick `system` OR `cluster` everywhere** (M effort, 2 days)
   - Recommendation: Keep `system` (schema column) as the canonical term
   - Rename all UI/docs/variables from "cluster" to "system"
   - OR: Run schema migration `system` → `cluster` (more churn, cleaner result)

### HIGH (Clean Up Before API Freeze)

4. **[API] Remove dead function exports** (S effort, 4 hours)
   - `src/inference/engine.ts`: Remove `binaryExists`, `createCodexEngine`, `createClaudeEngine`, `detectAvailable`
   - `src/cost.ts:96`: Remove `emptyUsageTotals`
   - `src/paths.ts:17`: Remove `DATA_DIR`

5. **[API] Investigate `sensePrFacts` and `executeResumePlan`** (M effort, 4 hours)
   - Confirm if truly dead → delete
   - OR document why they're kept (called dynamically?)

### MEDIUM (Maintainability Improvements)

6. **[API] Remove 61 dead type exports** (M effort, 1 day)
   - TUI types: Make `ClusterViewCtx`, `EpicViewCtx`, etc. non-exported
   - Hooks types: Mark `SectionOp`, `ClaudeMdLayer`, etc. as `@internal`

7. **[ARCH] Document hooks/ module boundary** (S effort, 2 hours)
   - Add `hooks/README.md` explaining the pipeline
   - Mark internal types with `@internal`

8. **[ARCH] Split catalogue/db.ts** (M effort, 1 day)
   - `db-schema.ts` (migrations, types)
   - `db-queries.ts` (read-only)
   - `db-mutations.ts` (writes, restricted to commands.ts)

### LOW (Nice-to-Have)

9. **[NAMING] Standardize identity vs responsibility** (M effort, 4 hours)
10. **[ERROR] Adopt Result<T> everywhere OR document hybrid model** (L effort, 2-3 days)
11. **[QUALITY] Add logger for structured errors** (L effort, 1 day)

---

## EFFORT SUMMARY

| Priority | Category | Total Effort |
|----------|----------|--------------|
| CRITICAL | 3 issues | **6-7 days** |
| HIGH | 2 issues | **1 day** |
| MEDIUM | 3 issues | **2-3 days** |
| LOW | 3 issues | **4-5 days** |
| **TOTAL** | **11 issues** | **13-16 days** |

**Minimum viable production-ready**: Fix CRITICAL issues only (1 week sprint).

---

## VERDICT

**Production-Ready**: YES, with CRITICAL fixes applied.

**Strengths**:
- ✓ Strict TypeScript, comprehensive types
- ✓ Clean module boundaries (cmux/, roles/)
- ✓ Zero commented-out code
- ✓ Result type at boundaries
- ✓ 58% test coverage by file count
- ✓ Rare throws (6 total)

**Weaknesses**:
- ❌ 67+ silent catch blocks (fail-open where should fail-closed)
- ❌ Circular dependency (catalogue ↔ resume)
- ❌ Naming inconsistency (system vs cluster)
- ❌ 84 dead exports (API surface bloat)

**Recommendation**: Fix CRITICAL issues (fail-open catches, circular dep, naming) in a 1-week hardening sprint before scaling the pr-watch fleet to 50+ PRs.
