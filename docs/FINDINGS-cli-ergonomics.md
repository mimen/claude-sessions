# CCS CLI Ergonomics & Config Audit

Read-only discovery audit of `/Users/mimen/projects/claude-sessions` (TypeScript, Bun). Findings ranked by user impact.

---

## (a) Command Surface Table

| Command | Args | Help Match? | Notes |
|---------|------|-------------|-------|
| `ccs` | - | ✓ | Launches TUI |
| `ccs reindex` | `[--titles]` | ✓ | - |
| `ccs ls` | `[--all] [--loops] [--event <slug>]` | ⚠️ **PARTIAL** | Help shows only `--event`, code also accepts `--all` and `--loops` (undocumented) |
| `ccs tree` | `[--all]` | ⚠️ **UNDOCUMENTED** | Help shows no flags, code accepts `--all` |
| `ccs whoami` | - | ✓ | - |
| `ccs meta` | `[<id>\|.]` | ✓ | - |
| `ccs rename` | `[<id>\|.] "<name>"` | ✓ | - |
| `ccs mark` | `[<id>\|.] --loop\|--completed\|--archived [--off]` | ⚠️ **ALIASES** | Code accepts both `--completed`/`--complete` and `--archived`/`--archive` (only long form documented) |
| `ccs tag` | `[<id>\|.] "<Entity>" [--remove]` | ✓ | - |
| `ccs key` | `[<id>\|.] <slug> [--off]` | ✓ | - |
| `ccs event` | `[<id>\|.] <slug> [--off]` | ✓ | Deprecated alias for `key` (documented) |
| `ccs parent` | `[<id>\|.] <parent-id\|.> [--off]` | ✓ | - |
| `ccs skill` | `[<id>\|.] <name> [--off]` | ✓ | - |
| `ccs role` | `[<id>\|.] <role> [--off]` | ❌ **UNDOCUMENTED** | Exists in code (cli.ts:127-128), not in HELP |
| `ccs resume-command` | `[<id>\|.] "<cmd>" [--off]` | ❌ **UNDOCUMENTED** | Exists in code (cli.ts:129-130), not in HELP |
| `ccs gus-work` | `[<id>\|.] <W-number> [--off]` | ❌ **UNDOCUMENTED** | Exists in code (cli.ts:131-132), not in HELP |
| `ccs epic` | `[<id>\|.] <epic-id> [--off]` | ❌ **UNDOCUMENTED** | Exists in code (cli.ts:133-134), not in HELP |
| `ccs phase` | `[<id>\|.] <phase> [--off]` | ❌ **UNDOCUMENTED** | Exists in code (cli.ts:135-136), not in HELP |
| `ccs project` | `[<id>\|.] <label> [--off]` | ✓ | - |
| `ccs system` | `[<id>\|.] <slug> [--off]` | ✓ | - |
| `ccs status` | `[<id>\|.] "<line>" [--off]` | ✓ | - |
| `ccs activity` | `[<id>\|.] needs-you [--off]` | ⚠️ **PREVIOUSLY FIXED** | Help now matches code (only `needs-you` valid, not `working`) |
| `ccs ready` | `[<id>\|.]` | ✓ | - |
| `ccs approve` | `<selector> [--off]` | ✓ | - |
| `ccs new-session` | `[flags]` | ⚠️ **INCOMPLETE** | Help lists: `--system --role --kind --phase --project --key --title --parent --cwd --prompt --permission-mode --print-id`. Code also accepts: `--skill` (synonym for `--role`), `--gus-work`, `--pr-number`, `--pr-repo`, `--resume-command`, `--inline` (all undocumented) |
| `ccs new` | `[flags]` | ✓ | Alias for `new-session` (case at cli.ts:147) |
| `ccs sync-tabs` | `[<id>\|.\|--all]` | ✓ | - |
| `ccs cluster` | `<system> [--expand\|--all]` | ⚠️ **UNDOCUMENTED FLAGS** | Help shows no flags, code accepts `--expand` or `--all` (cli.ts:177) |
| `ccs inbox` | `send\|bump\|drain\|pending` | ⚠️ **VAGUE** | Help doesn't detail required flags per subcommand |
| `ccs state` | `get\|set\|merge` | ⚠️ **VAGUE** | Help doesn't detail required flags per subcommand |
| `ccs grouping` | `set\|note\|get` | ❌ **UNDOCUMENTED** | Exists in code (cli.ts:170-171), not in HELP |
| `ccs hook` | `run <name>` | ✓ | - |
| `ccs hooks` | `<explain\|lint>` | ❌ **UNDOCUMENTED** | Exists in code (cli.ts:156-158), not in HELP |
| `ccs register-session` | - | ✓ | Alias for `hook run session-start` (documented) |
| `ccs statusline` | - | ❌ **UNDOCUMENTED** | Internal command (reads stdin), exists in code (cli.ts:161-165), not in HELP |
| `ccs roles` | `[ls\|upsert\|rm]` | ✓ | - |
| `ccs sync-roles` | `[--dry-run] [--hooks]` | ⚠️ **UNDOCUMENTED FLAGS** | Help shows no flags, code accepts `--dry-run` and `--hooks` (cli.ts:175) |
| `ccs resume-session` | `<id> [--dry-run]` | ✓ | - |
| `ccs resume-cluster` | `<cluster> [--dry-run]` | ✓ | - |
| `ccs resume` | `<selector> [flags]` | ✓ | Flags documented: `--role --pr --gus --epic --cluster --key --dry-run` |
| `ccs skills` | `[flags\|subcommands]` | ✓ | Refers to own help (`ccs skills --help`) |

**Internal/status codes (not user commands):**
- `already-open`, `resumed`, `not-indexed`, `spawn-failed`, `liveness-unreadable` are return status values from resume operations, not commands

---

## (b) Ergonomics Findings (Ranked by User Impact)

### **HIGH IMPACT**

#### 1. **Five fully functional commands missing from HELP** 
**Impact:** Users cannot discover or use key catalogue metadata commands  
**Location:** src/cli.ts:35-78 (HELP text)  
**Commands affected:**
- `ccs role [<id>|.] <role> [--off]` (cli.ts:127-128) — set canonical role identity (ADR-0015)
- `ccs resume-command [<id>|.] "<cmd>" [--off]` (cli.ts:129-130) — set loop re-arming command
- `ccs gus-work [<id>|.] <W-number> [--off]` (cli.ts:131-132) — bind GUS work item
- `ccs epic [<id>|.] <epic-id> [--off]` (cli.ts:133-134) — point session at epic entity
- `ccs phase [<id>|.] <phase> [--off]` (cli.ts:135-136) — set per-system activity phase

**Implementation files:**
- src/catalogue/commands.ts:408-425 (role)
- src/catalogue/commands.ts:428-445 (resumeCommand)
- src/catalogue/commands.ts:448-465 (gusWork)
- src/catalogue/commands.ts:468-485 (sessionEpic)
- src/catalogue/commands.ts:182-199 (phase)

**Fix:** Add all five to HELP text between `ccs system` (line 54) and `ccs status` (line 55)

