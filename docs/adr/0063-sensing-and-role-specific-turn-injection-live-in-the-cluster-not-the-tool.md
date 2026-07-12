# Sensing and role-specific turn-injection live in the cluster, not the tool

Decided with Milad 2026-07-11 from the "what pr-watch is leaking into the tool" audit. Evicts the last two
pr-watch implementation details still living in `src/`: the PR sensor (`pr-sense`) and the pr-agent phase
rubric (`phase-rubric`). Another instance of ADR-0061 (generic mechanism / cluster vocabulary), applied to
two behaviors rather than a data field.

## The leaks

The audit found the core primitives clean, but two whole behaviors in the tool are pure pr-watch:

1. **`src/pr-sense/` — a GitHub sensor in the tool.** `sensePrFacts(cwd)` shells out to GitHub and parses
   PR state (`MERGED`/`OPEN`/…). Sensing external facts is, by Milad's own three-homes model, the
   **engine's** job (`.ccs-config`, e.g. `catalogue_sync.py`), not the platform's. It's also flagged
   dead/orphaned by the dead-code audit (`sensePrFacts` is never imported) — so it's likely leaked *and*
   unused: a copy that was superseded by the Python engine sensor but never removed.

2. **`src/hooks/phase-rubric.ts` — a pr-agent turn-injection in the tool.** It gates on
   `row.role === "pr-agent"` and injects a block of pr-watch-specific instructional text (the stage ×
   activity self-check) into the worker's context every turn. That is cluster-authored guidance to one
   role, hardcoded in platform code and keyed on a literal role name.

## Decision

**Neither sensing nor role-specific turn-injection belongs in the ccs tool. Both are cluster concerns,
reached through mechanisms the tool already provides.**

1. **Sensing lives in the engine (`.ccs-config`).** The tool provides the generic primitive to *record*
   sensed facts — `mergeFields` / `stampPrFacts`-equivalent writes into the **catalogue** / **cluster
   state** / the ADR-0057 work-unit attributes — but it does not itself reach out to GitHub/Slack/git. The
   pr-watch engine (`catalogue_sync.py`, `sense.sh`) is the sensor; it writes facts, the tool stores them.
   **Remove `src/pr-sense/`** from the tool: delete it if it's the dead copy (verify no live caller), or if
   any path still uses it, migrate that path to consume engine-written facts. The tool keeps only the
   generic *write* surface, never the *fetch*.

2. **Role-specific turn-injection is a cluster-authored hook fragment.** The phase rubric is exactly what
   the **claude-md** / **stop** hook types already carry: per-**level** text resolved and injected at a turn
   boundary (ADR-0043/0044). It should be a `claude-md`/`stop` fragment in the **pr-agent role's**
   `.ccs-hooks/` dir, resolved through the normal hook layering — NOT a hardcoded `row.role === "pr-agent"`
   branch in `src/hooks/phase-rubric.ts`. **Remove `phase-rubric.ts`** from the tool; move its text into
   pr-watch config as a role-level hook fragment. The tool's job is to *resolve and inject* hook fragments
   (which it already does); it should not *author* one role's content.

## Why this is the right cut

- **The tool already has the generic mechanism for both.** Sensing → the generic fact-write surface
  (mergeFields / catalogue mutations). Turn-injection → the hook-resolution pipeline (ADR-0043/45). Neither
  leak adds capability; each is a *hardcoded instance* of a mechanism the tool already exposes generically.
  That is the precise signature of an ADR-0061 violation.
- **The inheritance test fails for both.** A second cluster (`event-watch`) inheriting a `pr-sense` GitHub
  fetcher, or a `phase-rubric` that injects pr-agent stage text keyed on a role it doesn't have, is
  obviously wrong. They only make sense for pr-watch → they belong in pr-watch's package.
- **It closes the audit.** With sensing and turn-injection evicted, and ADRs 0057/0060/0062 handling the PR
  columns, review verbs, and role names, `src/` carries no pr-watch vocabulary — the tool becomes a clean
  substrate any cluster runs on.

## Consequences

- **Delete `src/pr-sense/`** (module + test). Confirm `sensePrFacts`/`foldPrFacts` have no live callers
  first; if one exists, repoint it to engine-written facts. PR facts themselves are already moving to
  work-unit attributes (ADR-0057) — the sensor that *fills* them stays in the engine.
- **Delete `src/hooks/phase-rubric.ts`** and the `isPhaseWorker` gate; author the rubric as a pr-agent
  role-level `claude-md`/`stop` hook fragment in `.ccs-config`. The Stop-hook wiring that injects it
  (`worker-stop-command.ts`) generalizes to "inject the resolved role fragment," not "call phaseRubric if
  pr-agent."
- **Reinforces the ADR-0058 tool↔config contract:** the engine (config-side) senses and writes; the tool
  (platform-side) stores and resolves. Neither reaches into the other's job.
- **CHANGELOG (ADR-0058):** the phase rubric now arriving via a hook fragment (not a hardcoded injection) is
  transparent to agents, but note it in the pr-watch changelog for the config author.
- **Glossary/units:** **sense** is an engine step that WRITES facts via the tool's generic surface (the tool
  doesn't fetch); note the phase rubric is a pr-watch hook fragment, not a platform unit.
