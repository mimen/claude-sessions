# Findings: hook-system audit (agent a5893f44)

Read-only audit of the ccs hook system + cluster config. Lint status: `ccs hooks lint: OK — 30 hook
file(s), no problems`. Tests: 69/69 pass across 8 test files.

## (a) Hook inventory — 8 types

| Type | Fires On | Merge | Format | Row-resolved | Status | Notes |
|------|----------|-------|--------|--------------|--------|-------|
| claude-md | SessionStart | sections | md | ✅ | Active | Layered context (identity/constitution/epic/role) |
| start | SessionStart | ordered-actions | json | ✅ | Active | Actions: arm, drain-inbox |
| stop | Stop | ordered-actions | json | ✅ | Active | Turn-end reporting (no config files currently) |
| meta-update | Stop | set-union | json | ✅ | Active | Freshness contract (fields refreshed, not invented) |
| cmux-paint | SessionStart+Stop | most-specific | json | ✅ | Active | Tab appearance (title/color/pill) |
| statusline | statusLine slot | most-specific | json | ✅ | UNUSED | No config files present |
| spawn-location | new-session | most-specific | json | ❌ | Active | Pre-row resolution from launch request |
| guard | PreToolUse | union-deny-wins | json | ✅ | FUTURE | Type declared, no handler implemented |

## Role → hooks resolution map (pr-watch)
- Global: claude-md, meta-update (updated_at, phase)
- Cluster: claude-md, meta-update (gus_work, epic_id, pr_state)
- pr-agent: claude-md, start (drain-inbox), meta-update (result, judgment, pr_head_sha), spawn-location (worktree)
- control / concierge / slack-scout / eval: claude-md, start (arm), cmux-paint, spawn-location (role-dir)
- designer: claude-md, cmux-paint, spawn-location (role-dir)
- Epic-level (3 epics): claude-md context

Resolution order: user → cluster → role → epic → work-unit → identity (broad → specific). Deterministic,
pure function of the catalogue row, no cwd/env dependency.

## (b) Findings

### 🔴 CRITICAL — Hook double-registration
`~/.claude/settings.json:226-241` (SessionStart) and `:277-289` (Stop): both `ccs hook run
session-start` and `ccs hook run stop` registered TWICE with `matcher:"*"`. Every SessionStart/Stop
fires the hook 2×: duplicate drain-inbox (2nd sees empty), double arm note, claude-md injected twice
(bloats turn-1 context), pushRenderOps 2×, ~2× I/O per session boundary.
**Remedy:** remove one duplicate entry per hook array. [P0]

### 🟡 MEDIUM — Legacy worker-stop-hook.sh still registered
`~/.claude/settings.json:272` runs the old shell Stop hook alongside the new TS `ccs hook run stop`.
Both update `phase` for pr-agent via DIFFERENT detection (old = cwd/sessions.json lookup; new =
row.role==="pr-agent"). Race on which `ccs phase` write wins. Old hook drops events in `events/`.
**Remedy:** confirm events/ still consumed; if retired, remove old registration; else migrate event-drop
into worker-stop-command.ts. Never two hooks writing one field with different detection. [P1]

### 🟡 MEDIUM — phase-rubric injected only on Stop, not SessionStart
`phase-rubric.ts:18`, `worker-stop-command.ts:66-72`: rubric is additionalContext at Stop only. Comment
at phase-rubric.ts:4 claims "start via claude-md" but no SessionStart injection exists → a fresh
pr-agent makes turn-1 decisions without the activity self-check. Turn 2+ fine (prior Stop).
**Remedy:** inject on SessionStart for phase-workers, OR claude-md role section, OR fix the comment. [P1]

### 🟢 LOW / INFORMATIONAL (by design, no action)
- guard hook declared in HOOK_TYPES (hook-types.ts:69) but no handler in hook-run.ts HOOKS map. No
  guard.json files exist. Document as future or remove. [P2]
- meta-update Stop hook only writes updated_at itself; other fields rely on external writers (sensors,
  artifacts). This is the ADR-0044 freshness-contract design, not a bug. Lint validates known writers.
- drain-inbox resolves inbox from identityDir(responsibilityOf(row)), NOT cwd — correct (ADR-0041).
- arm dedup: config-driven arm (start.json) suppresses handleSessionStart's built-in; correct idempotent.
- Tab painting on both SessionStart (first paint) + Stop (turn-end refresh) is intentional; cmux idempotent.
- Resolution (resolve-levels.ts, resolve-config.ts) is a pure function; absent file contributes nothing;
  one format per (level,type) slot enforced (collision = lint error). Determinism contract (ADR-0045) honored.

## Verdict
Coherent and production-ready AFTER the P0 double-registration fix. Layered resolution, fail-open
semantics, deterministic merge, full observability (ccs hooks explain). 30 hook files, lint-clean, 69/69
tests. The legacy-stop-hook collision is a migration artifact to clean up.
