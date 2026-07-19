# ccs + cmux platform runbook

The operate-it reference for the ccs platform and its cmux substrate. This is a **living doc**, not an
ADR — the ADRs record *why* a decision was made; this records *what to do* when running the platform. It
covers the substrate every cluster runs on; cluster-specific operation lives in each cluster's own runbook
(e.g. `~/.ccs-config/clusters/pr-watch/docs/runbook.md`), which links up here for anything cmux/resume.

See also: ADR-0041 (three homes), ADR-0042 (spawn isolation), ADR-0054 (0.64 hook store + fail-closed
liveness), ADR-0058 (versioning contract).

---

## The three homes (know which layer you're touching)

- **the ccs TOOL** — the versioned binary. Owns the engine, hooks, commands, primitives, and the
  folder-structure contract. Pinned to a cmux version range.
- **`~/.ccs-config`** — git, your fleet *definitions*: clusters, roles, hooks, rendering rules. Iterated
  while you work, assuming the tool is stable.
- **`~/.ccs`** — runtime *state*, never git: the catalogue + index (`~/.ccs/cache/*.db`), cluster state
  (`~/.ccs/clusters/<c>/…`), identity inboxes. Created/updated as work happens.

Rule of thumb: a *definition* problem → fix in `~/.ccs-config`. A *state* problem → it's under `~/.ccs`
and the tool owns migrating it. A *behavior* problem → the tool.

---

## When cmux is unavailable

There are **two distinct failure modes** — they behave oppositely, so diagnose which one you're in.

### Case 1 — cmux is down / unauthed (the SAFE case)

Symptoms: `cmux tree` fails, "broken pipe / errno 32", or the socket won't answer.

What happens: the bridge's `readable` flag goes **false**, so any `ccs resume` **aborts and spawns
nothing** (fail-closed, ADR-0054). This is by design — it is always safer to skip a resume than to
duplicate a fleet you can't see.

What to do: **nothing forced.** The running fleet doesn't care that ccs can't query it — those processes
keep looping. When cmux comes back, liveness recovers on its own. Do **not** try to force a resume while
cmux is down; ccs will refuse anyway. Degradation is cosmetic + self-healing: `ccs ls` shows sessions as
closed, tab painting and live *wakes* go quiet — but the inbox is durable (ADR-0033), so no mail is lost;
it drains on next start.

The hard version: if the cmux **app** crashes (not just the socket), it takes the PTYs with it and the
fleet dies too — there's no surface to resume *into* until cmux is back. Recovery: relaunch cmux, then a
single `ccs resume-cluster <cluster>` (the hook store persists across the crash, so liveness reads
correctly and dedup works).

### Case 2 — cmux is UP, but a session was launched OUTSIDE the shim (the DANGEROUS case)

Symptoms: everything looks fine, `cmux tree` works, but a session that IS running reads as closed.

Cause: cmux 0.64 only tracks a session in its hook store if `claude` was launched as a **plain command
through cmux's shim** (an integrated-shell spawn). A bare `exec claude`, an env-scrubbed spawn, or a
hand-launched claude bypasses the shim → the session runs but is **untracked**.

Why it's dangerous: liveness is *readable* (the store reads fine), it just doesn't know about that session.
So a cluster resume would treat it as closed and **spawn a duplicate** on the same work-unit. Fail-closed
does NOT catch this — the store isn't unreadable, it's incomplete.

What to do: **always launch/resume through ccs** (see the operating rule below). If you suspect an
untracked live session, check `ps` for `claude` processes vs what `ccs ls` shows before running a broad
`ccs resume-cluster`. The one-embodiment claim (ADR-0072) protects the *spawn-vs-spawn* race, but it can't
protect against a session that was never registered. This is why the operating rule exists.

---

## The operating rule: always launch and resume through ccs

Every fleet session must be **born or resumed through the shim-registering plain-command spawn**
(`spawnCmux`). "Always use ccs" is shorthand for the invariants that keep liveness honest:

- **Never hand-launch a worker** (`claude` typed into a terminal for a fleet role). It won't register the
  way ccs's spawn does, and it won't carry the identity metadata.
- **Never scrub `CMUX_SURFACE_ID` / `CMUX_WORKSPACE_ID`** from a spawn. The 0.64 shim needs them to
  register the session (ADR-0054 retired the old scrub for the detached path). ccs spawns a fresh
  workspace, so there's nothing to hijack.
- **Never `exec claude`** in place — it bypasses the shim.
- **Never use agent-session surfaces** (`cmux new-surface --type agent-session`) for a resumable session —
  they have hardcoded argv and can't `--resume`. Terminal-surface + shim is the path.

If you follow this rule, Case 2 cannot happen. Everything ccs spawns registers correctly and is self-healing
across restarts.

---

## cmux version dependency

The tool is coupled to cmux's hook-store schema + shim behavior, so the version matters.

- **Required/supported: cmux ≥ 0.64.0** (tested against **0.64.17**). The 0.64 hook store
  (`~/.cmuxterm/claude-hook-sessions.json`, `activeSessionsBySurface`) is the liveness source.
- **The tool checks it at runtime** (`cmuxVersion()` in `src/cmux/live.ts`, ADR-0054 + version-guard):
  - **< 0.64.0** → the hook store predates the schema; the bridge reports `readable = false` and resume
    fails closed (with a stderr warning). You must upgrade cmux.
  - **0.64.x** → normal operation.
  - **≥ 1.0.0** → proceeds, but warns "untested major version" — a cmux major bump may have changed the
    store schema; verify liveness (`ccs ls` should reflect reality) before trusting a broad resume.
- **On a cmux upgrade:** re-check that `ccs ls` shows running sessions as open. If everything reads closed
  after an upgrade, the store schema likely moved — that's the ADR-0054 failure mode recurring, and the tool
  needs a bridge update, not a config change.
- **Override:** `CMUX_HOOK_STORE_PATH` env var repoints the hook-store path (for a moved store or a test
  environment).

---

## cmux config expectations (this machine)

`~/.config/cmux/cmux.json`:
- `sidebar.showBranchDirectory = false`
- `terminal.autoResumeAgentSessions = false` — IMPORTANT for shutdown (see below).

The cmux socket needs **auth** (`CMUX_SOCKET_PASSWORD` / integration-provided). A non-integrated background
shell can't drive cmux ("broken pipe" on every call) — **run ccs from inside a cmux surface**, not a
detached background shell. (This is a security gate, not a bug.)

---

## Stopping / restarting a fleet (the SIGTERM trap)

- **SIGTERM is ignored** by cmux-managed claude processes; cmux may restart them. Only SIGKILL stops a
  process when the cmux server is dead.
- **cmux auto-resume can respawn killed workers** — if `autoResumeAgentSessions` is on, a SIGKILL just
  triggers a respawn. This is why we keep it **false**.
- **Clean shutdown = close the cmux workspaces, NOT kill the PIDs.** Closing the workspace is what actually
  ends the session and removes its surface from the tree.
- To stop a whole fleet: close its workspaces (or disable autoResume first, then stop). Do not `pkill claude`
  and expect it to stick.

---

## Resume mechanics (what `ccs resume` actually does)

- `ccs resume <selector>` resolves the selector (id | `#pr` | `owner/repo#pr` | `W-number` | epic | role |
  cluster) to a set of sessions and resumes each through the shared core.
- Per session: check **liveness** via the bridge; if already embodied → skip (idempotent, no duplicate
  pane). Else `claude --resume <resumeId> [resume_command]` in the derived launch dir, spawned into a fresh
  cmux workspace via `spawnCmux`.
- **Fail-closed:** if liveness is unreadable, the whole pass aborts (`abortedUnreadable`) — nothing spawns.
- **Supersede-dedup:** in a cluster resume, if a work-unit already has a live session, older dead siblings
  are superseded (not resumed) — one PR never gets duplicate panes.
- **Loops** (roles with a `resume_command`) come back RUNNING; **workers** get a bare resume and rehydrate
  from their inbox/state.
- **Agents never resume the cluster.** Resuming is Milad's explicit action or a scheduler — a control/
  concierge tick must never run `ccs resume` (it caused a duplicate-fleet runaway). This is a constitutional
  rule for the fleet, enforced by the skills.

---

## Quick triage

| Symptom | Likely cause | Action |
|---|---|---|
| `ccs ls` shows everything closed | cmux down/unauthed (Case 1) OR cmux < 0.64 | Check `cmux auth status` + `cmux --version`; if down, wait/relaunch; if old, upgrade |
| A running session reads as closed | launched outside the shim (Case 2) | Don't cluster-resume; find it via `ps`, close+relaunch it through ccs |
| `ccs resume` says "liveness unreadable, aborted" | fail-closed working as intended | Fix cmux (auth/version), then retry |
| Everything closed right after a cmux upgrade | hook-store schema moved | Bridge needs updating (a tool change, not config) — see ADR-0054 |
| Tab shows stale title/status | sync-tabs sweep lagged, or session idle | `ccs sync-tabs <selector>`; it self-heals next tick |
| Duplicate workers on one PR | two spawns raced, or an untracked session | ADR-0072 claim prevents the race; for untracked, close the extra + always use ccs |
