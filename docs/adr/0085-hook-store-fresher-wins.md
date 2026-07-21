# ADR-0085: Hook-store contradictions resolve to the fresher signal

Status: **active** (adopted 2026-07-14, amended 2026-07-20)

## Context

`src/cmux/bridge.ts::parseHookStore` merges two views cmux writes to the hook store:

- `activeSessionsBySurface[surfaceId] = {sessionId}` — the surface-side binding.
- `sessions[sessionId].surfaceId` — per-session detail. This object accumulates history: multiple
  session records can claim the same surface after reattach or replacement.

On cmux 0.64.17, a `--resume` reattach can leave the old `activeSessionsBySurface` binding in
place. The per-session hook record is the fresher signal for a surface already covered by the
sessions view, but history must be reconciled before that view is merged.

## Decision

For each non-empty surface ID, `parseHookStore` first reduces `sessions` history to one winner:

1. A finite numeric `updatedAt` (Unix seconds) outranks a missing, invalid, or non-finite value.
2. Among finite timestamps, the greatest value wins.
3. Equal timestamps, including equally missing/invalid timestamps, use the lexically smallest
   session ID. This makes the result independent of JSON object order.
4. The resulting `SurfaceSession` is materialized entirely from the winning session record,
   including its workspace, cwd, lifecycle, restorable flag, pid, and finite `updatedAt`.

The selected sessions-view winner beats a contradictory `activeSessionsBySurface` entry. The active
map only fills surfaces not covered by the sessions view; when it fills a gap, it enriches the
binding from the corresponding `sessions[sessionId]` detail if present.

Reconciliation emits one bounded structured `log.debug` summary when the discrepancy state
changes. Repeated parses of the same state are deduplicated even if JSON object order changes;
returning to a clean state rearms the diagnostic for a later recurrence. The summary separately
counts discarded historical session
records and genuine active-map disagreements, with capped samples. It does not emit per-conflict
`console.error` output or unbounded context.

## Why not fail-closed drop the ambiguous binding?

The reattach case is the B14 scenario, and every ADR-0054-compliant caller downstream would then
fail-closed on it. The selected sessions record has a concrete freshness signal, so it is the
correct winner; active-map drift remains visible in debug diagnostics.

## Consequences

**What this fixes:**

- Post-reattach resumes resolve to the current session, not a stale historical record.
- Results are deterministic even when object order changes or timestamps are absent/invalid.
- Metadata cannot be accidentally borrowed from a losing historical record.
- Operators get one bounded diagnostic summary instead of one error per contradiction.

**What this changes for callers:**

- `parseHookStore` output includes a finite `updatedAt` when the winning record has one.
- `buildBridge` still intersects bindings with the live cmux tree and filters dead recorded pids.

## Verification

Focused regression coverage in `src/cmux/bridge.test.ts` covers newest-wins order independence,
winning-record metadata, valid/equal/missing/invalid timestamp ordering, sessions-over-active-map,
gap filling/enrichment, and absence of raw `console.error` output.

## Related

- Full-system review 2026-07-14, bug B14.
- ADR-0054 (fail-closed liveness) — the discipline this ADR calibrates for contradictory state.
- ADR-0040 (cmux capability audit) — established the cmux tree and hook-store sources.
