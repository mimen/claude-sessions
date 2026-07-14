# ADR-0078: Clusters read ccs state via JSON exports, not direct SQLite

Status: **active** (adopted 2026-07-14, "D1" ratified decision from full-system review)

## Context

Before this ADR, pr-watch's Python engine — `compose_board.py`, `worker_activity.py` — opened
`~/.ccs/cache/catalogue.db` via `sqlite3` and:

1. Selected raw catalogue columns directly.
2. Reimplemented the identity-key derivation (`pr:repo#num` / `gus:W-…` / `wu:<id>`) in Python.

Two failure classes fell out of this:

- **B3 — identity key drift.** The rules for "what's the identity of this row?" existed in three
  places: `src/catalogue/lineage.ts` (`identityKey`), `src/catalogue/db.ts` (`identityKeyOf`,
  reading a stored column that was populated only by explicit `setKey` calls), and
  `compose_board.py` (`identity_key`). The repo's own `docs/FINDINGS-dry-determinism.md` flagged
  this as an unfixed P0. The full-system review confirmed the drift risk was real: when the
  Python-derived identity and the TS-stored key disagree, `src/board/indexer.ts:bySession` silently
  returns null — the board row exists but the tool reports no data.
- **B10 — the schema is the interface.** Any change to the catalogue schema was secretly a
  two-repo, two-language migration. The declared cluster contract (`cluster.toml`, `board.json`)
  was fig-leaf on top of the real coupling.

## Decision

**ccs is the single source of truth for catalogue state, exposed via versioned CLI JSON exports.
Cluster engines shell out to `ccs`; they do not open `catalogue.db`.**

Concretely:

1. **Identity key is auto-derived on every mutation.** `db.ts` calls `refreshDerivedKey()` after
   any mutation that touches `role`, `pr_repo`+`pr_number`, `gus_work`, or `work_unit_id`.
   The stored `key` column is thereafter authoritative; `identityKeyOf()` just reads it. A
   backfill in migration `v31` populates the column for existing rows.
2. **`ccs catalogue export --cluster <c> [--role <r>] [--json]`** — the ONE authorized read path
   for cluster engines. Returns a versioned envelope (`schema: 1`) with a stable per-row shape.
3. **`ccs identity resolve --session <sid> [--json]`** — resolve one session to its identity key
   plus the columns it was derived from. Same envelope discipline (`schema: 1`).
4. **`ccs cluster <name> --json`** already existed (roster projection); its role expands to be
   the third pillar of the cluster-read API.
5. **Explicit `setKey` still wins as a freeform anchor** (ADR-0069). Auto-derivation only fills
   `key` when the row has identity-relevant columns AND no explicit key was set. This preserves
   the freeform-anchor use case without a special code path.

pr-watch's `compose_board.py` and `worker_activity.py` are ported to `ccs_client.py`, a tiny
subprocess wrapper. `sqlite3` imports for the catalogue are removed from the cluster.

## Consequences

**What this fixes:**
- B3 (identity key drift) is dead by construction. No cluster re-derives.
- B10 (schema-is-the-interface) is retired for the catalogue. Every future catalogue migration
  is a one-repo change; the export shape is what clusters see.
- The export envelope has a `schema` field so consumers can gate on version if a breaking change
  is ever needed.

**What this costs:**
- Each `ccs catalogue export` is a subprocess (fork+exec+JSON parse) instead of a direct SQL
  query. Measured cost is ~30–80ms per invocation on a warm machine — negligible against the
  scheduler's cadence (90s+).
- The tool→cluster contract now lives at the JSON schema, not the SQL schema. Additive-only
  discipline (matches the existing SQLite migration rule) is our safeguard against silent breaks.

**What this does not fix (yet):**
- The Index DB (`~/.ccs/cache/index.db`) is still opened directly by `worker_activity.py` for
  the session→cwd join. cwd is transcript metadata (not durable catalogue state). Projecting it
  through ccs is a follow-up; the immediate risk was in the catalogue, and this ADR takes it out.

## Verification

- Tests: `src/catalogue/catalogue.test.ts` (D1 auto-derive suite), `src/catalogue/export-command.test.ts`.
- Live: 45 rows exported, 26 identities sensed, both engines run end-to-end against the current
  catalogue on 2026-07-14.
- Migration: v30 → v31 backfills `key` on every existing row.

## Related

- ADR-0026 (identity key = responsibility) — this ADR consolidates its implementations.
- ADR-0038 (fresh embodiment rehydrates) — depends on identity-key correctness.
- ADR-0057 (work-unit as first-class entity) — sets the `wu:` key precedence.
- ADR-0069 (role anchor types incl. freeform) — the explicit-setKey exception is for that.
- The 2026-07-14 full-system review (Fable + GPT-5.6 Sol, five-seat), decisions D1 + D3 (partial).
