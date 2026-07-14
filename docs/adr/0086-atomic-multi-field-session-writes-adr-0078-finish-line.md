# ADR-0086: Atomic multi-field session writes — ADR-0078 finish-line

Status: **active** (adopted 2026-07-14, follow-up to ADR-0078)

## Context

ADR-0078 established the export boundary: cluster engines read ccs catalogue state via
`ccs catalogue export`, never direct SQLite. The 2026-07-14 hardening arc ported 2 of the
7 cluster Python scripts onto the export path. In the fresh production-readiness review
(2026-07-14 v2), the remaining 5 scripts were called out as P0 for shareability: the
schema was still the de-facto tool↔cluster contract for pr-watch's hot-path composer.

Of those 5, four had a straightforward migration path:

- **board.py, approve.py, completion.py, retire_sweep.py**: pure catalogue reads. Migrated
  to `catalogue_export()`.
- **mark_completed.py**: reads + writes. Migrated to `catalogue_export()` for reads, `ccs
  mark <sid> --completed` for writes (already the sanctioned single-field write command).

**catalogue_sync.py was the hard one.** It writes 5 fields per session per tick (cluster,
gusWork, groupingId, customTitle, stage) as one `INSERT ON CONFLICT` — atomic per session.
Migrating each field to a separate `ccs` subprocess call would:

1. Be ~60 subprocess forks per tick (12 PRs × 5 fields), turning a ~100ms operation into
   ~3.6s worst case.
2. Lose atomicity — a crash mid-sequence leaves a partial row.

The temptation was to document catalogue_sync as an "ADR-0078 exception." That's the
mechanism by which ADRs quietly die: every future contributor sees "there's already one
exception, mine is only slightly worse."

## Decision

**Add `ccs session-fields <sid> --json '{...}' [--sensor <name>]` — an atomic multi-field
session write. Migrate catalogue_sync onto it. No exceptions.**

### The command

```
ccs session-fields <sid> --json '{"cluster":"pr-watch","gusWork":"W-...","stage":"building",
  "customTitle":"...","groupingId":"...","meta":{"gus_work_sf_id":"..."}}' --sensor <name>
```

Every field routed through this command uses the SAME setter the equivalent CLI single-
field command uses (`setCustomTitle`, `setCluster`, `setGusWork`, `setSessionEpic`,
`setStage`, `setMeta`, etc). It's a batch of ADR-0068 mutation-boundary calls, not a
bypass. Stage writes require `--sensor <name>` for the same reason `ccs stage` does
(D5/ADR-0079).

### Fields accepted

Every writable session field on the catalogue row: `customTitle`, `role`, `project`,
`cluster`, `gusWork`, `workUnitId`, `groupingId`, `stage` (requires `--sensor`),
`statusLine`, `parkedTaskId`, `parentSessionId`, `key`, `completed`, `archived`, and
`meta` (an object of key→value pairs; null values delete the key).

### The write pattern in catalogue_sync.py

Before:
```python
cat.execute("INSERT INTO catalogue (session_id, cluster, gus_work, grouping_id,
             custom_title, stage, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT
             DO UPDATE SET ...", (sid, SYSTEM, w, epic_id, title, stage, now))
```

After:
```python
ccs_session_fields(sid, {
    "cluster": SYSTEM, "customTitle": title, "stage": stage,
    "gusWork": w, "groupingId": epic_id,
    "meta": {"gus_work_sf_id": gus_work_sf_id},
}, sensor="catalogue-sync")
```

One subprocess per session, all fields atomic through the mutation boundary.

### The read pattern in catalogue_sync.py

Reads pull the full pr-agent roster ONCE at the top of `main()` via `catalogue_export()`,
build a `(repo, num) → sessionId` map plus `sid → (milad_review, stage)`, and use those
maps locally. Zero subprocess overhead per PR for reads.

## Consequences

**What this fixes:**
- ADR-0078 is fully honored across every cluster Python script.
- No catalogue coupling remains: a schema migration on the tool doesn't require a
  coordinated cluster change.
- The `session-fields` primitive is the API a future new-cluster wizard, cluster
  scaffolding tool, or org-sync script would use to bulk-populate catalogue rows.

**Measured cost:**
- catalogue_sync full write of 12 PRs: **~2.9s wall time** (12 subprocess forks × Bun
  cold-start ~230ms). Comfortable within the 60-90s scheduler cadence.
- Reads are effectively free (one subprocess amortized across 12 PRs).

**What's still direct-sqlite (and why it's OK):**
- **compose_board.py, pill_sweeper.py, worker_activity.py**: read the *index* DB, not
  catalogue. ADR-0078 is specifically about catalogue coupling.
- **catalogue_sync.py fallback read** of stored_stage: read-only, single-row, colocated
  with the writer for atomicity of the field pack. Won't fire in the common case (the
  roster export covers it).

## Verification

- Live: catalogue_sync in `--write` mode processes 12 PRs in ~2.9s. All 12 sessions get
  the correct stage, gusWork, groupingId, customTitle stamped.
- ccs test suite: 620 pass. New test coverage: mutation-boundary allowlist updated to
  include the new command file with a documented reason.
- Live smoke: `ccs session-fields <sid> --json '{...}'` accepts strings, booleans, nested
  meta; refuses stage without `--sensor`; validates stage against the role's monotonic
  schema.

## Related

- ADR-0078 (export boundary) — this ADR completes it.
- ADR-0079 (stage is sensor-only) — session-fields inherits the `--sensor` guard.
- ADR-0068 (mutation-boundary rule) — session-fields is a sanctioned batch of the same
  setters commands.ts uses.
