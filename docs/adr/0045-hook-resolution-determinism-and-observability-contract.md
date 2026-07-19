# Layered hook resolution must be deterministic and inspectable

Follows ADR-0043/0044. Decided with Milad 2026-07-10; several rules added from a cross-model
review. Design doc: `docs/hook-resolution-draft.html` §07. We have paid for non-determinism
before (the CMUX_SURFACE_ID hijack, ADR-0042) — layered resolution must not reintroduce it.

## The rules (non-negotiable)

- **Resolve from the row, never from cwd or the environment.** The `session_id` on stdin is the
  only input; everything else is a pure lookup. Two sessions with the same identity resolve
  identically. (`spawn-location` is the one pre-row exception — it resolves from the launch
  request; ADR-0043.)
- **Corrupt config fails THAT TYPE closed — and keeps the valid broader layers.** A missing file
  = the level contributes nothing (fine). A present-but-unparseable file is an error: log it,
  mark the session `degraded` (ADR-0035), and drop ONLY that one bad layer — the already-resolved
  broader layers still apply. Never discard valid inherited config because a lower level was
  malformed; never half-apply.
- **Fixed path, no search, one format per slot.** Exactly `<levelDir>/.ccs-hooks/<type>.{md,json}`.
  No globbing, no "nearest match," no parent-walk. Two formats for the same (level, type) is a
  validation error, not a silent pick.
- **Merge order is the level order, always** (user → cluster → role → epic → work-unit →
  identity). The type's structured merge (ADR-0044) decides HOW layers combine; the order never
  varies.
- **Strategy is per-type and static** (ADR-0044) — never overridable per level or per file.
- **`.ts` is deferred; ship JSON + MD only.** A `.ts` config can read env / clock / network /
  branch, which breaks "effective behavior = pure function of (row + config tree)." Until a
  written sandbox spec exists (allowed imports, no I/O, no clock) and is restricted to a few
  blessed types (`cmux-paint`), config is declarative JSON + prose MD only.
- **File-presence enrollment needs validation** — `ccs hooks lint` flags unknown/misnamed hook
  files and unknown types, so a typo (which silently un-enrolls a level) surfaces.
- **Runtime identity overrides logged with a content hash.** The `~/.ccs` identity level is
  mutable + unversioned; every use logs its content hash so "what actually ran?" is answerable.

## Observability requirement

Ship `ccs hooks explain <session|identity> <type>` as a first-class command: it prints which
levels contributed, the structured-merge steps, and the effective config — the determinism
guarantee made inspectable.

## The test

Given a `session_id` + a hook type, the effective behavior MUST be a pure, reproducible function
of (row + config tree) — loggable and unit-testable without a live cmux or a live session. If it
isn't, the implementation is wrong.

## Consequences

- Two new CLI commands: `ccs hooks lint`, `ccs hooks explain`.
- Per-type combinators are pure functions over (ordered layers) → effective config; that's the
  primary test seam.
- The `degraded` flag (ADR-0035) is reused for a corrupt layer, scoped to the one hook type.
