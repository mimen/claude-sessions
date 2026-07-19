# cmux workspace enumeration must sweep all windows (one wrapper, every caller through it)

Corollary of ADR-0014. If the workspace ref is the while-open handle, then any
liveness or "is there already a pane here" check must be able to SEE every live ref.
A bare `cmux list-workspaces` cannot. Decided with Milad 2026-07-09.

> **Confirmed + mechanism (ADR-0040, 2026-07-09).** Re-tested with 4 windows: a bare
> `cmux tree` (and `list-workspaces`) shows only the current window; **`cmux tree --all`
> spans every window**. So the "one merged-sweep wrapper" is `tree --all --json
> --id-format both`, and identity/liveness key on the **surface UUID** (surface → workspace
> is a clean 1:1-up lookup; workspace → surface is 1:many, so the surface is the key). Every
> bare call site must move to `--all`.

## The bug

`cmux list-workspaces --json` returns only the CURRENT window's workspaces. Observed
live: a bare call returned 19 of 25 actual workspaces (4 windows: 19 + 4 + 1 + 1).
Every consumer that calls it bare is therefore window-blind:
- a liveness sweep reads other-window refs as falsely DEAD → a running session looks
  gone → spurious "needs revival";
- `spawn-agent`'s "is there already a pane at this cwd?" check misses a pane in
  another window → spawns a DUPLICATE;
- `resume-fleet`'s reuse detection has the same blindness.

There are ~11 bare call sites today: 4 in ccs (`live-by-cwd.ts`, three in
`open-state.ts`) and ~6 in pr-watch (`ensure-control.sh`, `resume-fleet.sh`,
`spawn-agent.sh` x2, `session_liveness.py`, `resync-labels.sh`).

## Verified facts that make the fix trivial

- **Refs are globally unique across windows** (ADR-0014): window 0 had 1,3,60,62,…;
  window 1 had 59,32,27,30; windows 2-3 had 31 and 24 — zero overlap. So merging the
  per-window lists is a plain union; no dedup, no window-tagging needed.
- **The sweep recovers the full set**: `list-windows` → `list-workspaces --window <id>`
  for each window → concat = all 25 (verified against the bare 19).

## Decision

One merged-sweep primitive, and every caller routes through it. Two layers:

- **ccs internal helper** — `listAllWorkspaces(cmuxBin)` (in `open-state.ts` or a small
  `cmux.ts`): run `list-windows`, then `list-workspaces --window <id>` per window,
  concat the `workspaces` arrays. The 4 ccs call sites call this instead of raw
  `list-workspaces`.
- **A CLI verb for shell/python consumers** — `ccs list-workspaces --json` emitting the
  same merged array, so pr-watch's bash/python pipe it through `jq` exactly as they do
  now, just over the complete set. One primitive, both consumer languages.

(Name: `ccs list-workspaces` to match the terse verb style — `ccs cluster`, `ccs resume`,
`ccs sync-tabs`. Milad may prefer `list-all-cmux-workspaces`; either is fine, one verb.)

## Cost / caveats

- **N+1 cmux calls** (1 `list-windows` + 1 per window). 4 windows = 5 calls — trivial.
  At large window counts it adds latency; the existing 2000ms timeout + short-TTL probe
  cache in `open-state.ts` already bound that. Not a concern at current scale; noted so
  "why not one call" is answered (cmux offers no single all-windows flag).
- **Reachability unchanged**: if cmux is unreachable the sweep returns empty, same as
  today (callers treat empty as "not open" — safe for idempotency). The socket-env
  reachability fragility is separate (its own decision).

## Consequences

- Liveness, spawn-dedup, and resume-reuse all see the true live set → no false-dead, no
  duplicate panes across windows.
- Reinforces ADR-0014: the ref is only useful as a handle if enumeration is complete;
  this makes enumeration complete.
