# ccs owns the metadata store + provides the renderers; each role drives its own per-session surfaces via hooks. The TUI is ccs's own.

Simplifies the display path AND draws the ownership line precisely. Today the two
per-session surfaces have two different owners, and the statusline carries pr-watch-specific
machinery the role-folder + materialization model (ADR-0018, ADR-0022) makes unnecessary.
Decided with Milad 2026-07-09; ownership framing corrected 2026-07-09 to match ADR-0029.

## The ownership split (this is the whole point)

"ccs owns the surfaces" was too coarse. Three distinct responsibilities:

1. **The metadata store — ccs owns it.** The single source of truth for every session's
   PR#, work-item, epic, phase (ADR-0025/0031). Nothing else holds display state.
2. **The renderers — ccs PROVIDES them.** `sync-tabs`/`renderTab` for the tab; a
   ccs-provided `statusLine` command for the statusline. A role never writes its own
   painting logic; it uses ccs's.
3. **Keeping it current — the ROLE does this, via its hooks (ADR-0029).** The role updates
   its own metadata as it works, and re-syncs its own per-session surfaces. ccs does NOT
   walk the fleet repainting everyone; there is no central painter.

So: **ccs owns the store and the renderers; each role keeps its own metadata fresh and
resyncs its own tab/statusline through its hooks.** The metadata flows one way (role → ccs
store → renderers), so surfaces never disagree.

## The three surfaces, by who drives them

- **The ccs TUI — ccs's own surface, end to end.** Native cross-fleet view + control panel
  (every session by cluster/role, open/closed, phase; resume/tag/complete/organize). ccs
  reads the store directly and renders it live. NO per-session hook involved — this is the
  one surface ccs both owns and drives.
- **The cmux tab — ccs renders, the PRIMARY session triggers.** `ccs sync-tabs` does the
  painting (`renderTab` → `workspace-action`), but it must be CALLED: the role's hook invokes
  it after updating its metadata. ccs supplies the brush; the role decides when to paint.
  There is exactly one tab per workspace, so a workspace with multiple claude surfaces needs
  one deterministic owner: the **primary session** = the earliest surface running a claude
  agent in the workspace (pane index, then index-in-pane), per the ADR-0040 audit. A
  non-primary session's hook computes "am I primary?" (a pure function of tree position) and
  skips the paint. No lock, no contention. (In practice the audit found zero workspaces with
  >1 claude session, so this is a safety rule, rarely exercised.) The statusline is
  per-surface, so it never contends — every session paints its own.
- **The Claude Code statusline — ccs renders, self-refreshing.** A ccs-provided `statusLine`
  command, materialized into the role's settings, re-runs each turn and reads current ccs
  metadata. It needs no explicit trigger (the turn is the trigger), but it's still the
  role's materialized instrumentation reading the store — not ccs pushing.

## What this retires (the pr-watch-specific machinery)

Previously the statusline was a pr-watch mechanism: `spawn-agent.sh` wired the worktree's
`.claude/settings` to run pr-watch's `statusline.py`, reading a `.pr-watch.json` marker file
seeded at spawn and refreshed every tick by `cmux_label.py`. That's two moving parts + a
private state file + a refresh loop, all a separate source that could drift from ccs.

Now: the role's materialized `statusLine` reads ccs directly. No `.pr-watch.json`, no
`cmux_label.py` refresh loop. One source (the ccs store), read live.

## Relationship to ADR-0029 (no contradiction)

ADR-0029 says each role owns its own upkeep via its hooks. This ADR is consistent with that:
- ccs owns the STORE + the RENDERERS (mechanism);
- the ROLE owns UPDATING its metadata + TRIGGERING its per-session resync (ADR-0029);
- only the TUI is ccs-driven, and it's not per-session so no role owns it.
"ccs owns the display" would contradict 0029; "ccs owns the store + renderers, the role
drives its surfaces" does not.

## Consequences

- Build: add a ccs `statusLine` renderer + keep `sync-tabs`; have `sync-roles` materialize
  the `statusLine` setting and a tab-resync call into each role's hooks (ADR-0029/0034).
  Retire `statusline.py` + `.pr-watch.json` + `cmux_label.py`'s marker refresh.
- The tab and statusline share the exact same metadata + phase vocabulary, so they always
  agree; the TUI reads the same store, so all three agree.
- A cosmetic read that can't reach ccs, or a role hook that failed to refresh, renders
  `unknown` from `updated_at` — never a stale value asserted as current (ADR-0031/0035).
- Reinforces ADR-0025 (no private system display state) and ADR-0029 (role-owned upkeep):
  the last bit of pr-watch-owned display state folds into ccs, but the DRIVING stays with
  the role.
