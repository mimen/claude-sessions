# Spawning must be detached into a fresh cmux workspace — never inline (the CMUX_SURFACE_ID hijack)

Verified against the cmux open-source code (manaflow-ai/cmux @ v0.64.10, our installed
version) after a live corruption: `ccs new-session` inline-launched a control session and it
took over the DESIGNER's tab. Decided with Milad 2026-07-10. This is the determinism keystone
for spawn/resume.

## What went wrong (observed)

`ccs new-session --role control` (default launch mode) did
`Bun.spawnSync(["claude","--session-id",<new>], {stdin/stdout:"inherit"})` from inside the
running designer session's terminal. Result: the designer's cmux tab was renamed "control" and
cmux's persisted state mapped the designer's surface to the control session id. Two sessions
appeared to be "control".

## Why — the verified mechanism (cmux source)

cmux does NOT key agent↔surface by tty (an earlier guess — wrong). It keys by
**`CMUX_SURFACE_ID`**, an env var cmux injects into every surface's shell:

- `Sources/GhosttyTerminalView.swift:6058` — cmux sets `CMUX_SURFACE_ID` + `CMUX_WORKSPACE_ID`
  in the environment of every surface it creates. Confirmed live: our designer shell has
  `CMUX_SURFACE_ID=8D67E236…`.
- `CLI/cmux.swift:25590` (SessionStart hook handler) — when a claude session fires its
  SessionStart hook, cmux reads `CMUX_SURFACE_ID`/`CMUX_WORKSPACE_ID` from the inherited env
  and `store.upsert(sessionId, surfaceId, …)` — binding that surface to the session, and
  **OVERWRITING any prior binding** for that surface.
- `Sources/GhosttyTerminalView.swift:5322` — `cmux new-workspace` creates a surface with a
  FRESH UUID and its own PTY.

So: a `claude` process **inherits the CMUX_SURFACE_ID of whatever surface spawned it**. An
inline `Bun.spawnSync(…, stdio:"inherit")` runs the child in the CALLER's surface env, so the
child's SessionStart hook rebinds the caller's surface to the child. That is the hijack.

## Decision — spawn contract

1. **ccs never inline-launches a session into the caller's terminal.** Default launch spawns
   DETACHED via `cmux new-workspace --cwd <dir> --command "claude …"`, which gives the new
   session its OWN fresh surface (own `CMUX_SURFACE_ID`) — no collision, deterministic.
2. **Strip `CMUX_SURFACE_ID` + `CMUX_WORKSPACE_ID` from any spawned child's environment**
   (belt-and-suspenders): even if some path doesn't go through `new-workspace`, an unset
   surface id means the child's hook can't rebind a foreign surface. cmux assigns a fresh one.
3. **`--inline` is an explicit escape hatch** for a genuine interactive `claude` in the current
   terminal (accepting that it binds to this surface — correct only when that IS the intent).
4. **Validate before spawn (error, don't half-spawn):** role exists in the registry (if
   `--role`), cwd/home_dir exists, a loop role has a resume_command. A misconfigured spawn
   fails loudly instead of producing a broken/mis-bound session.

## Corroborated model facts (from the same source read)

- ccs's surface bridge reads cmux's authoritative persisted state (`session-com…json`,
  surface-keyed) — the right source, not a hack (reinforces ADR-0040).
- `resumeBinding.cwd` comes from the SessionStart HOOK's reported cwd, not tty/surface
  introspection — confirming ADR-0021 issue #2 (Claude-Code-reported cwd can drift); ccs
  derives its own launch dir and is immune.

## Consequences

- Rewrite `new-session` launch: detached `cmux new-workspace` by default; scrub CMUX_SURFACE_ID/
  WORKSPACE_ID from the child env; `--inline` opt-in; pre-spawn validation.
- The same detached path is what resume/rebirth of core roles must use (it already does, via
  spawn-agent.sh for workers and the manual cmux new-workspace for the core rebirth).
- Cleanup: the corrupted designer→control binding is stale persisted state; a fresh SessionStart
  from the designer re-binds it correctly, and sync-tabs must skip archived rows (done) so a
  defunct control row can't repaint the designer tab.
