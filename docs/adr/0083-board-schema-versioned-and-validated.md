# ADR-0083: Board schema is versioned + zod-validated on read (D2 / B11)

Status: **active** (adopted 2026-07-14, "D2" ratified decision from full-system review)

## Context

Bug B11 in the 2026-07-14 full-system review flagged two related weaknesses in the
tool↔cluster contract:

1. `src/board/paths.ts::readBoard()` did `JSON.parse` + a bare `as Board` cast. A malformed
   row from a second, less-dogfooded composer parsed fine and crashed deep in `buildMaps()`
   or the TUI paint code, with no "board malformed" signal at the boundary.
2. The cluster gate (`checkClusterGate`) ran only on `resume-cluster`. `ccs new-session`
   spawned workers into a cluster whose `requires_ccs` declared a MAJOR shortfall (config
   expected v2, tool at v0) — the sensor and catalogue-sync would then quietly disagree.
   `ccs board --recompose` also skipped the gate.

## Decision

**Every board read validates against a versioned zod schema. Every mutation path runs the
cluster gate before touching the cluster.**

Concretely:

1. New `src/board/schema.ts` defines `BoardSchema` with `passthrough()` on every object so
   extra fields (per-cluster `data` blobs, legacy `prs[]`, `senseHealth`, `ticketedNoPr`,
   the `today`/`sprints` timeline) are preserved but never validated. Only the fields the
   tool actively reads are enforced.
2. `parseBoard(raw)` returns `{ ok, value | error }`. Never throws.
3. `readBoard(cluster)` calls `parseBoard`, logs a boundary error and returns null on
   failure (fail-open: a bad board is treated as "no board", not a poisoned board).
4. `BOARD_SCHEMA_VERSION` is exported; the schema accepts an optional `schemaVersion` on
   the top-level object so a future breaking change can be gated. Clusters that don't emit
   it default to v1 (current shape).
5. `ccs new-session` runs `checkClusterGate` after the cluster is defaulted from the role
   def. A `refuse` verdict returns exit 2 with no spawn; a `warn` verdict prints but
   continues.
6. `ccs board --recompose` and `--recompose-all` run the gate before invoking the
   cluster's composer. Read-only board commands skip the gate (a stale-tool render is
   still useful info).

## Consequences

**What this fixes:**
- B11's silent-crash-on-malformed-board class is dead: a malformed row is caught at the
  boundary with a specific error citing the failing field.
- New-session no longer spawns workers into a major-mismatched cluster.
- Board recompose no longer invokes a stranger cluster's composer past a major gap.

**What this does not fix (yet):**
- The rest of "D2 versioned executable protocol" — declaring the composer/sense entry as
  a versioned argv+protocol+timeout in `cluster.toml` instead of a python3 shellout — is
  NOT implemented here. That's a bigger design change requiring every cluster to migrate;
  Phase 1 keeps the current shape and gates it via the schema + `requires_ccs`. Follow-up.

## Verification

- Tests: 6 new cases in `src/board/schema.test.ts` cover valid boards, extra-field
  passthrough, envelope unwrapping, malformed JSON, missing required fields, and
  invalid severity enums.
- Full test suite: 616 pass, 0 fail.

## Related

- Full-system review 2026-07-14, decision D2, bug B11.
- ADR-0058 (inter-layer version contract) — this ADR completes gate enforcement.
- ADR-0077 (phase-first board / identity-keyed rows) — the shape being validated.
- ADR-0078 (D1 export boundary) — same "schema at the boundary" discipline.
