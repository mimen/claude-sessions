# The session id is the embodiment RESUME HANDLE; the cmux ref is a while-open handle; cwd is derived, never identity

Refines ADR-0008 (which said resume is "keyed on cwd"). Milad pushed on what a
session actually IS versus what a cmux workspace is, and the distinction dissolves
several fragilities the earlier framing carried. Validated live against real cmux
data + the Claude Code store on 2026-07-09.

> **Retitled 2026-07-09.** This ADR originally read "session identity IS the Claude
> session id." ADR-0024/0026 later established that the durable AGENT identity is the
> **responsibility** (`[cluster]·role·[work-unit]`, ADR-0030), and the session id is the
> **resume handle for one embodiment**, not the durable name of the agent. Everything below
> is correct with that reframing: the session id is what you `claude --resume`, the cmux ref
> is the while-open body handle, and cwd is derived — none of these three is the identity.

## The three things and what each is FOR

1. **Session** — a durable Claude Code transcript file
   (`~/.claude/projects/<encode(cwd)>/<session-id>.jsonl`). Its identity is the
   **Claude session id** (the UUID you pass to `claude --resume <id>`). A session can
   be closed and reopened as a brand-new process; the id is what survives.
2. **cmux workspace** — a disposable "body" that houses a running claude process. It
   exists only while open. We need to identify it ONLY for its open lifetime, for two
   jobs: (a) manage its display metadata (title/description/color) and (b) determine
   liveness (is this session's body still open? → drives the cmux display and tells a
   cluster-resume which sessions still need reopening).
3. **cwd** — the directory a session was created in. It is a DERIVED fact, not an
   identity. It is recoverable on demand from the session id (the storage-folder name
   under `~/.claude/projects/` decodes to it, and the transcript records `cwd` in its
   events). It is never the key to a session.

## Decision

- **Identity = the Claude session id.** Full stop. Not cwd, not title, not the
  workspace ref. The catalogue keys every row on `session_id`; that is the one true
  name of a session. (Unchanged; stated plainly here because ADR-0008's "keyed on
  cwd" wording obscured it.)

- **The cmux workspace ref (`workspace:N`) is the primary while-open handle.**
  Verified live: `workspace:N` is a single GLOBAL monotonic allocator — unique across
  ALL windows (window 0 had 1,3,60,62,61,…; window 1 had 59,32,27,30; no overlap),
  assigned at creation, never reassigned to a different workspace while others are
  open, retired on close. It resets only on a full cmux restart. That is exactly
  enough: we only ever need it for the body's open lifetime, and we never reconnect to
  a pre-restart ref (resume spawns fresh bodies). So: **record the ref at spawn**
  (`cmux new-workspace` returns `OK workspace:N`; we already parse it) and use it as
  the handle for all display-metadata and liveness operations for that run.

- **Liveness = "is the recorded ref still in the live workspace set?"** — swept across
  ALL windows (see the multi-window care below). A recorded ref that is gone = that
  body closed = the session needs reopening on a cluster resume. This works even when
  two sessions share a cwd, because the key is the ref, not the directory.

- **cwd is derived on demand, never stored as identity.** The ONLY place cwd is
  load-bearing is the `claude --resume` launch directory (Claude Code must run from
  the dir whose `encode(realpath)` equals the session's storage folder). That dir is a
  pure function of the session id via the filesystem walk ccs already has
  (`resume/locate.ts` `locateLaunchDir`). So even the resume launch does not need a
  stored cwd; it needs a lookup.

## Why the ref is adequate despite being "volatile"

The earlier worry ("`workspace:N` is volatile across reboot, so don't key on it") was
solving for a persistence requirement that does not exist. We NEVER carry a ref across
a cmux restart. Within a single run the ref is stable and globally unique, which is the
whole lifetime we need it for. A reboot loses the bodies (expected — they are
disposable) and cluster-resume rebuilds them, minting new refs recorded at that spawn.

## Foreign / not-spawned-by-ccs bodies (the residual)

If ccs did not spawn the body (a manual pane, or a lost registry), there is no
recorded ref. cmux exposes NO command that emits the Claude session id live
(`list-workspaces`/`list-panes`/`identify` give the ref + cwd + title, never the id).
The session id lives only in the persisted state file
(`~/Library/Application Support/cmux/session-com.cmuxterm.app.json`) at
`windows[].tabManager.workspaces[].panels[].terminal`:
- `agent.sessionId` — the Claude session id
- `resumeBinding.checkpointId` — the same id, plus the exact resume command
- `ttyName` — the pane tty

None of those carry the live ref, so bridging a foreign body's `sessionId → ref`
still requires a join, and the only field the persisted record and `list-workspaces`
share is `cwd` (title is rejected as a key — brittle, collides). This join is a
FALLBACK for foreign bodies only; it is collision-prone when two claude sessions share
a directory, and we accept that limitation for the foreign case because the fleet
never relies on it (fleet bodies are all ccs-spawned with a recorded ref).

Caveat found while validating: cmux's `resumeBinding.cwd` can DRIFT from the session's
true creation cwd (observed: a session created in `/Users/mimen` had
`resumeBinding.cwd = /Users/mimen/.claude/pr-watch-2`). That drift is an upstream cmux
resume bug (it can make `claude --resume` fail with "No conversation found"), tracked
separately. It does NOT affect our identity model, because we key on the session id
(`checkpointId`/`agent.sessionId`), which is correct; only cmux's own cwd field is wrong.

## Operational cares

- **Multi-window enumeration.** A bare `cmux list-workspaces` returns only the CURRENT
  window's workspaces (observed: 19 of 25). A liveness sweep MUST iterate
  `list-windows` → `list-workspaces --window <id>` for every window, or a ref in
  another window reads as falsely dead. (Current code calls bare `list-workspaces`;
  that is a bug to fix when this model is implemented.)
- **Record the ref at spawn.** `spawn-agent.sh ensure` already parses `workspace:N`
  from `new-workspace`; it must store it as the session's handle in the registry
  (keyed by session id), so no join is ever needed for fleet bodies.

## Consequences

- Multiple sessions per cwd is fine — cwd is no longer an identity, so nothing
  collides. This also unblocks role-based hooks: a role can be housed in whatever
  directory carries the `.claude/settings` it needs, WITHOUT that directory doubling
  as the session key.
- ADR-0008 stands as the resume-reconcile behavior, but its "keyed on cwd" language is
  superseded: resume identity is the session id; cwd is the derived launch dir; the
  ref is the while-open handle. The idempotent-reconcile guarantee is unchanged.
- The ccs TUI browsing ALL machine sessions (not just the fleet) keeps the persisted-
  file `agent.sessionId → {cwd}` join as its only option for foreign bodies, with the
  known cwd-collision limitation.
