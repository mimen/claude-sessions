---
name: ccs-upkeep
description: Operate ccs-managed session clusters correctly — map sessions to their cmux workspaces, check cluster health, bring a cluster up/down, resume or rebirth roles, sync tabs, and keep the ~/.ccs (runtime) vs ~/.ccs-config (definitions) split intact. Use when maintaining pr-watch or any ccs cluster, diagnosing "why isn't this session live / on the right tab", or after a reboot.
---

# ccs upkeep — operating the model correctly

ccs maps disposable Claude Code sessions onto durable **agent identities**. This skill is
the runbook for keeping that mapping healthy. The design is in `~/Documents/pr-watch-2/docs/`
(ADRs 0014–0041 + architecture-intentions.html); this is the operational how-to.

## The three homes (never confuse them)

| Path | What | Git? |
|---|---|---|
| `~/projects/claude-sessions` | the ccs **tool** (code) | its own repo |
| `~/.ccs-config/` | **definitions**: clusters/<c>/roles/<role>/{skills,commands,settings} | ONE git repo |
| `~/.ccs/` | **runtime**: identities, inboxes, cluster state (board/gate/…) | NEVER git (holds routed Slack/PR content) |

Rule: anything a human authors → `~/.ccs-config`. Anything the fleet generates → `~/.ccs`.
`~/.claude` is Claude Code's own dir; ccs only *materializes symlinks/hooks* into it.

## The identity model (what maps to what)

- **Identity = responsibility** = `[cluster]·role·[work-unit]` (e.g. `pr-watch·pr-agent·metered/W-123`).
  Durable. Inbox + state key on this, NOT the session id.
- **Session id** = the Claude conversation. The resume handle. Disposable.
- **Surface** = the terminal a session runs in (cmux). Has a stable UUID.
- **Workspace** = the cmux tab; holds one-or-more surfaces.

**The bridge** (surface-keyed, exact — no title/cwd guessing):
```
surface UUID  ↔  Claude sessionId + resumeBinding   (cmux persisted state file)
surface UUID  →  workspace          (cmux tree --all, 1:1 up)
```
cmux stores this in `~/Library/Application Support/cmux/session-com.cmuxterm.app.json` and
exposes UUIDs via `cmux tree --all --json --id-format both`. ccs reads both.

## Map a session → its workspace (the #1 question)

```bash
# is a session live, and where?
ccs meta <id>                 # catalogue metadata (role, system, phase, PR)
ccs cluster pr-watch          # whole cluster: members by role, live/idle dot, per-PR
```
Programmatically the resolver is `locateSession(sessionId)` → `{surfaceRef, workspaceRef,
windowRef}`. Liveness is `openSessionIds()` (bridge-derived, exact). If a session shows a
**stale workspace title** (e.g. control's tab says "Print CLAUDE_CODE_SESSION_ID variable"),
that's just an unsynced title — run `ccs sync-tabs <id>`; the ROLE (from the catalogue) is
the truth, not the tab title.

## Bring a cluster up (after reboot / close)

```bash
ccs resume-cluster pr-watch --dry-run   # preview: resumed / already-open / superseded / retired
ccs resume-cluster pr-watch             # do it
```
- **resume** = re-embody an existing session (keeps transcript/context). Use for WORKERS and
  any warm session. Loops come back RUNNING (their `resume_command` replays).
- **rebirth** (`ccs new-session --top-level --role <name>`) = fresh session in the role's dir, armed from
  the registry. Use for CORE LOOPS / new work only — NOT workers (rebirth loses PR context).
- resume-cluster automatically: skips already-open, supersedes stale duplicates of a
  work-unit, skips retired (completed/archived). One live embodiment per responsibility.

## Bring a cluster down

```bash
# find + close pr-watch sessions (never close your own session!)
ccs cluster pr-watch          # see what's live
# pinned workspaces must be unpinned first:
cmux workspace-action --action unpin --workspace <ref>
cmux close-workspace --workspace <ref>
```
Closing is SAFE — state is durable in `~/.ccs`, resume brings it back. That's the whole point.

## Core roles: rebirth into their role dirs

Core loops (control/scout/eval/concierge) should run in their role dir, not `$HOME`:
```bash
ccs new-session --top-level --role control    # inherits home_dir + resume_command from the registry
```
If you're replacing an old misplaced session, **archive the old one** so it's not left behind:
```bash
ccs mark <old-id> --archived
```

## The folder-trust gotcha (learned the hard way)

A resumed/spawned session in a directory with `hasTrustDialogAccepted=false` (in
`~/.claude.json`) shows Claude Code's "trust this folder?" prompt and **blocks pre-first-turn**
— it won't register as live until a human hits Enter. Symptom: workspace spawns but
`isOpen()` stays false, no agent in cmux's persisted state.

Fix: pre-trust the dir once:
```bash
python3 - <<'PY'
import json, os
fp=os.path.expanduser('~/.claude.json'); d=json.load(open(fp))
d.setdefault('projects',{}).setdefault(os.path.expanduser('<DIR>'),{})['hasTrustDialogAccepted']=True
open(fp,'w').write(json.dumps(d,indent=2))
PY
```
Role dirs + `$HOME` are already pre-trusted for pr-watch. New role dirs need this.

## Materialization (definitions → ~/.claude)

```bash
ccs roles ls                  # what roles are defined
ccs sync-roles                # symlink skills/commands into ~/.claude (reconcile, prunes stale)
ccs sync-roles --hooks        # ALSO merge ccs hooks into ~/.claude/settings.json (managed block)
```
Safe: prunes only ccs-created links (tracked in `~/.ccs/materialization-manifest.json`), never
touches user files. Hooks merge with the user's own — ccs owns only its tagged entries.

## Layered hook config (ADR-0043/0044/0045)

A session's behavior is composed from layered config resolved from its ROW (identity), not its
cwd. Config files live at `<level-dir>/.ccs-hooks/<type>.{md,json}`, layered broad → specific:
`user → cluster → role → epic → work-unit → identity`. Enrollment = file-presence (a level
opts in by having the file). Config levels live in `~/.ccs-config` (git); the identity level in
`~/.ccs` (runtime).

```bash
ccs hooks explain <session|.> <type>   # which levels contributed + the effective merged config
ccs hooks lint                         # flag unknown types / bad formats / collisions /
                                       #   dead meta-update fields / unhandled start actions
```
Hook types + how their layers merge:
- `claude-md` (sections, floor-protected) — the layered context injected on SessionStart.
- `meta-update` (set-union) — a FRESHNESS CONTRACT: which fields should be fresh; values come
  from each field's own writer (sensor/artifact/timestamp), never from the agent remembering.
- `start` (ordered-actions, EXECUTED) — arm / drain-inbox on SessionStart.
- `cmux-paint` / `statusline` / `spawn-location` (most-specific-wins) — one owner each.

Determinism: resolves purely from the row; a corrupt layer fails THAT type closed (session
`degraded`) while valid layers still apply. Edit config → `ccs hooks lint` → `ccs hooks explain`.

## Messaging + state (any cluster)

```bash
ccs inbox send  --cluster pr-watch --role pr-agent --work-unit W-123 --from control --message "…"
ccs inbox bump  ...           # deliver + wake the live tab (for non-looping workers)
ccs inbox drain --role …      # read + move-to-processed (a role does this at task start)
ccs state get   --cluster pr-watch board          # read cluster shared state
ccs state set   --cluster pr-watch board --json '…' --source control
ccs state merge --role … result --json '…'        # single-writer-per-field update
```
All state is enveloped (schemaVersion + updatedAt + source), atomic, under `~/.ccs`.

## Health checklist (run periodically / after a reboot)

1. `ccs cluster <c>` — every intended member live? correct role/epic grouping?
2. Any session `⚠ degraded` (started but not registered)? — a hook likely failed; it self-heals
   on next start, or re-run its registration.
3. `ccs resume-cluster <c> --dry-run` — should be "0 to resume" if everything's up.
4. Tabs stale? `ccs sync-tabs --all`.
5. State fresh? `ccs state get --cluster <c> board` — check `updatedAt` is recent (a loop tick).
6. Old/misplaced sessions left behind? `ccs mark <id> --archived`.
7. Hook config sound? `ccs hooks lint` — no dead contracts / unhandled actions / collisions.

## Don'ts

- Don't key liveness/identity on cwd or tab title — use the surface bridge (they drift).
- Don't write runtime state into `~/.ccs-config` (leak risk) or definitions into `~/.ccs`.
- Don't rebirth a warm worker (loses context) — resume it.
- Don't hand-edit `~/.ccs/materialization-manifest.json` or ccs's managed hook block.
