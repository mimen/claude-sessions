# Break the catalogue↔resume circular dependency: new-session is a spawn orchestrator, not a catalogue query

Decided 2026-07-11 from the dead-code/boundaries audit. A confident structural cleanup — the boundary
violation is unambiguous and the fix is mechanical. Reinforces the module-boundary discipline the audit
praised for `cmux/`.

## The problem (confirmed present)

`src/catalogue/new-session.ts` imports from `src/resume/` (`shellQuote` from `resume/command.ts`,
`spawnCmux` from `resume/spawn-cmux.ts`), while `src/resume/*` imports from `src/catalogue/db.ts`
(`getRow`, `sessionsForSystem`, `lifecycleOf`, …). That's a cycle:

```
catalogue/new-session.ts → resume/command.ts, resume/spawn-cmux.ts
resume/resume-*.ts        → catalogue/db.ts
```

Root cause: `new-session.ts` is misfiled. It is a **spawn orchestrator** (mint id → write catalogue row →
launch via spawnCmux), not a catalogue query/mutation module. It lives under `catalogue/` only by history.

## Why it matters

- Refactoring risk: changes in either module cascade unpredictably across the cycle.
- Testing/mocking ambiguity; some bundlers/tree-shakers choke on cycles.
- It violates the intended layering: **catalogue = data; resume/spawn = orchestration over data.** The
  orchestrator may import the data layer; the data layer must not import the orchestrator.

## Decision

**Move `new-session.ts` to the orchestration layer** so imports flow one way (orchestration → data):

- Relocate `src/catalogue/new-session.ts` → `src/resume/new-session.ts` (or a new `src/spawn/`). It already
  belongs with `resume-session.ts`/`spawn-cmux.ts` — both are "launch a claude into a cmux workspace."
- After the move, `new-session` importing `resume/command` + `resume/spawn-cmux` is same-layer (fine), and
  it importing `catalogue/db` is orchestration→data (fine). The cycle is gone.
- Verify with `bunx madge --circular src/` (add to the pre-commit/CI check so a cycle can't reappear).

If a reason ever forces `new-session` to stay under `catalogue/`, the fallback is the split the audit noted:
`catalogue/reserve-session.ts` (mints id + writes row, NO resume imports) + `resume/launch-session.ts`
(calls reserve, then spawns). But the straight move is simpler and preferred.

## Consequences

- One file moves; its importers update their path (`ccs new-session` wiring in `cli.ts`). No behavior
  change.
- `madge --circular` (or equivalent) becomes a standing guard so the boundary holds.
- Pairs with the general "orchestration imports data, never the reverse" rule; keeps `cmux/`-quality
  boundaries across the codebase.
