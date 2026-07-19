# ADR-0079: Stage is engine-computed; `ccs stage` is sensor-only

Status: **active** (adopted 2026-07-14, "D5" ratified decision from full-system review)

## Context

Before this ADR, the catalogue had a `stage` column that was written by both:
- The **sensor** (`catalogue_sync.py`) — computing a monotonic latch from GitHub state, CI,
  reviewer verdicts, and `meta.milad_review`.
- **Anyone via `ccs stage <id> <value>`** — including workers, humans, and (historically)
  worker Stop hooks.

Meanwhile, the phase-first board (ADR-0077) added a `data.stage` field to each composed row —
the cluster's own computed effective stage, with the GitHub-wins rule applied.

That meant two stage state machines existed side by side:
- `catalogue.stage` — per-session, ccs-written, workers-writable.
- `data.stage` on the board — per-identity, cluster-composed.

The full-system review flagged this seam as the weakest in the codebase (finding B1 was exactly
this desync: the sensor's read of the board failed silently, and the two stages drifted every
tick until manually reconciled). The pr-watch constitution's rule "Lifecycle is control's, not
yours" was enforced by convention, not by mechanism — a worker running `ccs stage . milad-review`
was a valid transition.

## Decision

**Stage is 100% engine-computed. `ccs stage` is a sensor-only primitive; worker writes are
mechanically refused.**

Concretely:

1. **The board's `data.stage` is the source of truth.** The cluster composes it from its own
   sensed facts; the tool doesn't know what a stage means.
2. **The catalogue.stage column stays, but is a WRITE-THROUGH CACHE.** Only the sensor
   (`catalogue_sync.py`) writes it, and only to mirror the board's effective stage for
   rendering (statusline, TUI, pill). No consumer treats catalogue.stage as authoritative for
   state-machine transitions.
3. **`ccs stage` gains three modes:**
   - **Read** (no value, no `--sensor`): print the current cached stage. Exit 0.
   - **Write** (value + `--sensor <name>`): write the stage, subject to the role-declared
     vocabulary and monotonic constraints. Exit 0.
   - **Worker write** (value, NO `--sensor`): **REFUSED** with exit 2 and a redirect message.
     The user is pointed at `meta.milad_review = approved` (the one worker-authored signal
     that participates in the state machine, and only via `/prwatch:approve`).
4. **The stage-schema validation (vocabulary + monotonic) still runs on sensor writes** — a
   bogus value or a backward move from a buggy sensor fails loud.

## Consequences

**What this fixes:**
- The B1 desync class becomes structurally impossible. There is only ever one authoritative
  source (the board), and one write path to the cache (the sensor).
- The constitution rule "workers don't set their own stage" is now a mechanical guarantee, not
  a convention teachers have to enforce.
- Future clusters inherit the discipline: `ccs stage` is a platform-level cache/read primitive,
  cluster-composed stage on the board is the state machine.

**What this costs:**
- Existing scripts that call `ccs stage <id> <value>` without `--sensor` will fail. This is
  intentional — every such call was a violation of the constitution rule.
- Docs referencing "worker runs `ccs stage`" needed updating (done in this arc:
  `pr-agent/.ccs-hooks/claude-md.md`, `docs/runbook.md`, `docs/live-verification.md`).

**What this defers (not part of this ADR):**
- The stage column is NOT deleted. A full elimination would require moving the render cache
  to cluster state (a JSON store keyed by identity) and refactoring statusline/TUI reads. The
  cache-with-write-through model captures D5's contract ("stage is engine-computed") without
  that refactor scope. Elimination is a Phase 5 candidate if it turns out to be needed.

## Verification

- Live: `ccs stage <id> <value>` exits 2 with the redirect message. `ccs stage <id> <value>
  --sensor <name>` succeeds. `ccs stage <id>` (read) prints the cached stage.
- Tests: all 610 pre-existing tests pass. `setStage` (the DB primitive used by tests and by
  the sensor's direct-write path) is unaffected.

## Related

- ADR-0060 — generic meta map (partially superseded by this ADR's resolution: stage is not
  a "blessed column workers write"; it's a sensor-cache).
- ADR-0064 — role-declared stage schema (still enforced; sensor writes are validated).
- ADR-0077 — phase-first board (defines `data.stage` as the composed truth).
- ADR-0078 — export boundary (`ccs catalogue export`) — the same discipline applied to reads.
- Full-system review 2026-07-14, decision D5.
