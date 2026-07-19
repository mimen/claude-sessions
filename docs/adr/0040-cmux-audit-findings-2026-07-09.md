# cmux capability audit (2026-07-09) — what THIS cmux binary actually exposes

Before building the ccs↔cmux bridge, we audited the installed cmux
(`/Applications/cmux.app/Contents/Resources/bin/cmux`) against the assumptions
ADR-0014/0016/0021 were written on. Several assumptions were outdated in our favor.
This ADR records the empirical findings and adjusts the affected ADRs. Run against the
live machine 2026-07-09.

## What we tested and found

### 1. cmux exposes stable per-object UUIDs (new)
`cmux tree --id-format both` prints a UUID for every window / workspace / pane / surface
alongside the short ref, and the global handle rule is: **commands accept "UUIDs, short
refs, or indexes"** for any workspace/window/pane/surface argument. Example:
`workspace workspace:60  9F5C6F8C-…-CD366F919042  "pr-watch-control"`.

So the volatile `workspace:N` ref is NOT the only handle — there is a **stable UUID** we
can record at spawn and use across the workspace's life. This is a better durable handle
than the short ref (which ADR-0014 already flagged as while-open-only).

### 2. cmux stores the CLAUDE SESSION ID per surface, on disk (big one)
`~/Library/Application Support/cmux/session-com.cmuxterm.app.json` persists, under
`windows → … → surface → agent`, an object:
```
{ "kind": "claude",
  "sessionId": "aea5bc4f-04dc-4c3d-92d3-2d1b2e9b0a78",
  "workingDirectory": "/Users/mimen/Documents/pr-watch-2",
  "launchCommand": { "arguments": [...], "environment": {...}, "capturedAt": … } }
```
and a sibling `resumeBinding`:
```
{ "checkpointId": "aea5bc4f-…", "autoResume": true, "cwd": "/Users/mimen",
  "command": "cd '/Users/mimen' && '/…/claude' '--resume' 'aea5bc4f-…'" }
```
So cmux DOES know each surface's Claude session id and its exact resume command — it just
doesn't surface the session id in the `tree` CLI output. ccs can read the session id (and
the resume binding) for ANY surface, including foreign panes ccs didn't spawn, by reading
this file keyed on the surface UUID — no full-disk transcript scan, no title matching.

### 3. Verb surface (all accept a workspace/surface/window handle)
Confirmed present: `new-workspace`, `tree`, `list-workspaces`, `workspace-action`
(rename/set-description/set-color/set-status/pin/…), `send`, `send-key`, `send-text`,
`send-panel`, `send-key-panel`, `new-pane`, `new-surface`, `set-status`. All take
`--workspace/--surface/--window <id|ref|index>`. `new-workspace` takes `--cwd`, `--command`,
`--name`, `--description`. This is the full ccs↔cmux contract for spawn, render, and wake.

### 4. All-windows sweep — CONFIRMED: `tree` needs `--all`
Re-tested with 4 windows open (36 surfaces). A bare `cmux tree` shows **the current window
only**; `cmux tree --all` spans every window. So ADR-0016's requirement is confirmed
NECESSARY and satisfiable: every enumeration must pass `--all` (and `new-workspace`/
`new-pane` still default to the CALLER's window, so spawns must be explicit about `--window`
when placing a body outside the caller's window).

### 6. surface → workspace mapping is total and clean; workspace → surface is 1:many
Verified across all 4 windows / 36 surfaces via `tree --all --json --id-format both`:
- **Every surface resolves to exactly one workspace** by structural containment
  (surface ∈ pane ∈ workspace). Zero orphans. So `surface_id → workspace_id` is an
  always-available lookup — going UP the tree has no edge case.
- **A workspace can hold MANY surfaces** (4 of the open workspaces do: e.g. `workspace:1`
  had 4 surfaces — a claude session plus shells). So workspace → surface is 1:many and
  ambiguous; the workspace is NOT a valid identity key.
- **But only ONE surface per workspace runs a `claude` agent** in practice: across all 36
  surfaces, ZERO workspaces had >1 claude session (the extras are plain shells / `~`
  prompts). So the "two agents fighting over one tab" case is theoretical, not live.

### The identity/tab ownership rule (decided from the above)
- **Identity, inbox, state, statusline key on the SURFACE UUID.** Every session has its own
  surface, so these never contend — regardless of how many surfaces share a workspace.
- **The workspace TAB (one per workspace) is owned by the PRIMARY session** = the earliest
  surface RUNNING A CLAUDE AGENT in the workspace (order by pane index, then index-in-pane).
  The "running a claude agent" filter matters: the naive first surface can be a plain shell.
  This makes tab ownership a pure function of tree position — recomputable any tick, no lock,
  no coordination. A non-primary agent computing "am I primary?" sees it isn't and skips the
  paint; its own identity/inbox/statusline are unaffected (those key on its surface).

So: session ↔ surface UUID (1:1, exact) → workspace UUID (1:1 up) → tab ops. The only
many-ness is workspace→surfaces, resolved by the primary-session rule. Titles/cwds stay out
of the identity + liveness + tab-ownership paths entirely.

### 5. Naming: `--name`, not `--title`
`new-workspace` and `workspace-action rename` use `--name` (there is no `--title` flag).
A build detail, recorded so scripts don't guess wrong.

### Incidental: the full pr-watch core is live
The audit tree showed control (`workspace:60`), scout (`:61`), eval (`:3`), and the
concierge we just spawned (`:66`) all running — the whole core, not just workers.

## Adjustments to prior ADRs

- **ADR-0021 (upstream issues) — issue #1 is DOWNGRADED, not eliminated.** The claim was
  "cmux stores the session id but doesn't expose it, so a foreign pane falls back to a cwd
  join." Reality: cmux stores it in `session-com.cmuxterm.app.json` per surface, so ccs can
  READ it (file), even for foreign panes — the fallback is a FILE READ keyed on surface
  UUID, not a fuzzy cwd/title join. The `tree` CLI still omits it, so the *nice-to-have*
  upstream ask ("expose sessionId in `tree --id-format`") remains, but it is no longer
  load-bearing — we are not blind to foreign panes. Update ADR-0021 accordingly.
- **ADR-0014 (session id + while-open ref) — STRENGTHENED.** Two concrete handles now
  exist: (a) the stable workspace/surface **UUID** for the live body, recorded at spawn or
  read from `tree --id-format both`; (b) the **session id**, readable from the cmux state
  file per surface. ccs no longer needs a title match for the common case.
- **ADR-0016 (sweep all windows) — CONFIRMED + concretized.** Re-tested with 4 windows: a
  bare `tree` shows only the current window; `tree --all` spans all. Every enumeration must
  pass `--all`. The requirement stands and the mechanism is known.
- **ADR-0032 (embodiment detection) — REORDERED + keyed on surface.** Identity/liveness key
  on the **surface UUID**; detection chain is surface UUID → session id (from the cmux state
  file) → cwd → title. The session-id read makes detection far more reliable than the title
  fallback we'd assumed.
- **ADR-0027 (display ownership) — the tab has a deterministic owner.** The workspace tab is
  painted by the PRIMARY session (earliest claude-surface in the workspace, see rule above),
  so "which session owns the tab" needs no lock — it's a pure function of tree position.
  Non-primary sessions skip the paint; the statusline is per-surface so it never contends.

## Consequences / build notes

- ccs reads `session-com.cmuxterm.app.json` to bridge surface ↔ Claude session id ↔ resume
  binding — this is the source of truth for "which session is in which live tab," including
  foreign panes. Treat it as read-only cmux-owned state; do not write it.
- Record the workspace **UUID** (not just `workspace:N`) at spawn for a stable while-open
  handle (ADR-0014).
- ccs spawns via `new-workspace --cwd <role-dir> --command "claude …" --name "<label>"`;
  wakes via `send` + `send-key` (ADR-0028's `bump-session`); renders via `workspace-action`
  / `set-status` (ADR-0027). Enumerate with `tree --all --json --id-format both`.
- Identity/liveness/inbox/statusline key on the **surface UUID**; the tab is owned by the
  workspace's **primary session** (earliest claude-surface). Titles/cwds stay out of the
  identity path (cwd survives only as a role hint for foreign-session registration and for
  resume launch-dir derivation, ADR-0021 issue #2).
