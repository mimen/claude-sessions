# ADR-0085: Hook-store contradictions resolve to the fresher signal

Status: **active** (adopted 2026-07-14, resolves B14 from the full-system review)

## Context

`src/cmux/bridge.ts::parseHookStore` merges two views cmux writes to the hook store:

- `activeSessionsBySurface[surfaceId] = {sessionId}` — the surface-side binding.
- `sessions[sessionId].surfaceId` — the per-session detail.

On cmux 0.64.17, a `--resume` reattach leaves the OLD `activeSessionsBySurface` binding in
place and doesn't update it — the surface-side view becomes stale. The per-session view
(`sessions[sid].surfaceId`) is rewritten by the reattach hook and stays fresh.

Before this ADR, `activeSessionsBySurface` was inserted into the surface-session map
FIRST, and the `if (map.has(surfaceId)) return;` guard dropped the fresher `sessions[sid]`
binding on the floor. Consequence (bug B14): after a reattach, the bridge resolved the
surface to the OLD session id, so a `ccs resume` on the current identity would skip it
("already open") or worse, resume the stale one.

The review noted:

> ADR-0054's fail-closed guard covers unreadable sources, not contradictory-but-valid ones.
> Potential effect: resume skips the dead identity and relaunches the live one, or makes
> the wrong duplicate decision.

## Decision

**When the two views disagree on the same surface, the `sessions[sid].surfaceId` view
wins. Contradictions are logged so an operator can spot drift.**

Concretely:

1. `parseHookStore` now inserts `sessions[sid].surfaceId` bindings FIRST (the fresher view).
2. `activeSessionsBySurface` fills in any surface the sessions view didn't cover (a
   legitimate case: cmux knows a surface via the byMap but hasn't yet written a
   `sessions[sid]` entry for it).
3. When a surface appears in BOTH views with different sessionIds, the first-inserted
   (sessions view) wins by design, and the discarded binding is logged with an
   explanatory message pointing at "likely stale post-reattach."

**Why not fail-closed drop the ambiguous binding?** The reattach case is *the* B14
scenario, and every ADR-0054-compliant caller downstream would then fail-closed on it —
resume would abort, lookups would return null, the wrong side would keep winning. The
fresher signal has an operational reason to be fresher (the hook fires post-reattach),
so it's the correct winner.

## Consequences

**What this fixes:**
- Post-reattach resumes now resolve to the current session, not the stale one.
- Any contradictory hook-store state is visible in the log with the KEPT / discarded
  session ids called out, so operator diagnosis is one-shot.

**What this changes for callers:**
- `parseHookStore` output is deterministic even when the store carries contradictions.
- The `buildBridge` tree-intersect still drops any surface that isn't currently in the
  cmux tree, so a stale binding that survives the merge still gets filtered downstream.

## Verification

- Tests: 3 new cases in `src/cmux/bridge.test.ts` — fresher wins, activeSessionsBySurface
  fills gaps, contradictions log AND keep the sessions winner.
- Full test suite: 620 pass, 0 fail.

## Related

- Full-system review 2026-07-14, bug B14.
- ADR-0054 (fail-closed liveness) — the discipline this ADR calibrates one edge case for.
- ADR-0040 (cmux capability audit) — established that `sessions[sid].surfaceId` is the
  freshest source after reattach, on which this ADR builds.
