# Findings: ccs↔cmux coupling-surface audit (agent adee59ed)

cmux 0.64.17 installed. 11 distinct subcommands, 22 call sites, 8 files. Core = src/cmux/ (3 files).
Surface-UUID join + fail-closed is CORRECT for 0.64.17. P0 gaps block multi-machine/version-varied deploy.

## (a) Dependency surface

| Subcommand | Location | Flags/Args | Fields read | Parsing | Failure mode |
|------------|----------|-----------|-------------|---------|--------------|
| `tree --all --json --id-format both` | cmux/live.ts:35 | --all, --json, --id-format both | windows[].workspaces[].panes[].surfaces[] {id,ref,type,title,index_in_pane,tty} | JSON→parseTree | UNREADABLE → fail-closed ✓ (ADR-0054) |
| `tree --all --json` (legacy) | catalogue/open-state.ts:129,165 | --all,--json | workspaces[].title, ref | JSON→title-join | ⚠ fail-OPEN → null="nothing open" |
| `list-workspaces --json` | open-state.ts:199,241,278 | --json | current_directory, title, ref | JSON, 2 schema variants | ⚠ fail-OPEN → null/empty |
| `new-workspace` | resume/spawn-cmux.ts:38 | --cwd,--name,--command,--focus | stdout+stderr | REGEX `/workspace:[0-9]+/` | fail-closed on spawn; ref-miss SILENT |
| `select-workspace` | cmux/liveness.ts:81 | --workspace,--window | none | none | best-effort → false |
| `focus-window` | cmux/liveness.ts:86 | --window | none | none | best-effort → silent |
| `rename-workspace` | liveness.ts:102, sync-tabs.ts:86, open-state.ts:307 | --workspace,--,title | none | none | best-effort → false |
| `workspace-action` | sync-tabs.ts:98,106,117,126 | --workspace,--action,[--description/--color] | none | none | best-effort → silent |
| `set-status` | sync-tabs.ts:141 | key,label,--workspace,[--icon/--color/--priority] | none | none | best-effort → silent |
| `send` | inbox/bump.ts:38 | --surface,--,text | none | none | best-effort → false |
| `send-key` | inbox/bump.ts:42 | --surface,--,key | none | none | best-effort → false |

## (b) Schema coupling — exact fields (break on cmux rename)

**tree → parseTree (bridge.ts:90-116):** windows[].{id,ref} → workspaces[].{id,ref,title} →
panes[].{id,ref,index} → surfaces[].{**id [KEY JOIN]**,ref,type,title,index_in_pane}. Rename/remove of
id/ref/index/index_in_pane breaks liveness. No version guard.

**hook store `~/.cmuxterm/claude-hook-sessions.json` → parseHookStore (bridge.ts:147-163):**
- `sessions[id].{workspaceId,cwd,agentLifecycle,isRestorable}` (detail; ignores pid/transcriptPath/etc.)
- `activeSessionsBySurface[surfaceUUID].sessionId` [KEY JOIN, authoritative]
- Path hardcoded (live.ts:24). Missing file = readable-but-empty (OK). Unparseable = UNREADABLE (fail-closed).
- Store accretes history; buildBridge intersects with live tree so accretion is harmless.

**list-workspaces (legacy):** current_directory, title, ref. normTitle() glyph-strip+lowercase is fragile.

## (c) Parsing fragility
- new-workspace ref via bare regex on stdout+stderr — MOST fragile (format change → ref=null → paint skipped).
- hook store has no `version` field — ccs assumes exact shape.
- title normalization fragile to glyph-format changes (mitigated by surface-UUID join; legacy path still uses it).

## (d) Version — NO runtime guard
Installed 0.64.17. Required >=0.64 (hook store) per ADR-0054, NOT enforced. Where a guard should live:
live.ts:readTree (probe cmux --version), readHookStore (degrade to legacy if <0.64), cli.ts startup banner.
Current behavior: cmux <0.64 → no store → "nothing open"; cmux 0.65 schema change → unparseable → fail-closed stuck.

## (e) Failure handling
- UNREADABLE fail-closed: tree read, hook store read. Safe (no dup spawns) but cluster stuck until cmux fixed.
- Best-effort silent (9 ops): tab paint, focus, send-key. Cosmetic. Timeouts present (2-4s).
- fail-OPEN dangerous: legacy list-workspaces parse failure → "nothing open" → dup spawns possible.
- Timeout inventory: tree 2s, select/focus 3s, rename 4s, workspace-action/set-status 4s, send/send-key 3s,
  list-workspaces 2s. **spawn-cmux.ts:41 Bun.spawnSync = NO explicit timeout (Bun default).**

## Findings ranked
- **P0-1 No cmux version guard** → add cmuxVersion() probe (live.ts:58); require >=0.64, warn >=1.0. [→ task #6]
- **P0-2 Hook store path hardcoded** → add CMUX_HOOK_STORE_PATH env override (live.ts:24). [→ #6/#9]
- **P0-3 new-workspace ref via bare regex** → JSON-first parse, regex fallback; request upstream --json. [→ #9]
- **P0-4 spawn-cmux missing timeout** → add timeout:10000. Small, do early. [→ #9]
- **P1-5 Retire legacy open-state.ts title-join fail-OPEN path** → migrate to surface-UUID bridge. [→ #5/#9]
- **P1-6 list-workspaces 2 schema variants** fragile → retire with legacy path. [→ #13]
- **P2-7 Tab-paint ops no retry** → 2×/500ms backoff. [→ #9]
- **P2-8 wakeSurface no delivery confirm** (durable inbox covers). [→ #9]
- **P3-9 catch swallows cmux error detail** → log actual error, CCS_DEBUG. [→ #13]
- **P3-10 No cmux call latency/failure metrics** → traced-exec wrapper. [→ #13]
- **P3-11 Upstream: cmux stable liveness API + hook-store version field.** [→ upstream/#13]

## Verdict
Surface-UUID join + fail-closed CORRECT for 0.64.17. P0 gaps (version guard, hardcoded path, regex ref,
missing spawn timeout) tolerable single-user, block multi-machine/version-varied deployment. Phase 1-2
hardening → production-grade.
