# Remove dead code: the legacy liveness paths and the unused-export surface

Decided 2026-07-11 from the dead-code audit. A confident cleanup — these are provably unreferenced or
superseded; removal is not a judgment call, only verification-before-delete. Also closes the CI-2 loose end
(the legacy fail-open liveness path) by deleting the thing rather than guarding it.

## What's dead (verified)

1. **`src/catalogue/open-state.ts`** — the pre-ADR-0040 title-join liveness path. Its own header says it's
   superseded by `cmux/liveness.ts` (the surface-UUID join). It is the **legacy fail-OPEN path** flagged by
   CI-2 (catch→null = "nothing open" → duplicate-spawn risk). No live module imports it for liveness (the
   remaining references are prose/comments and unrelated "open-state" column labels). → **delete.**

2. **`src/catalogue/live-by-cwd.ts`** — the even-older cwd-match liveness path, also explicitly superseded
   by `cmux/liveness.ts` per the liveness.ts header ("replaces the title-join in open-state.ts and the
   cwd-match in live-by-cwd.ts"). Its own comment notes it "always empty, so resume was never idempotent."
   → **delete.**

3. **The unused-export surface (84 findings)** — 61 dead type exports + 23 dead function/const exports the
   audit enumerated. Notably: `binaryExists`, `createCodexEngine`, `createClaudeEngine`, `detectAvailable`
   (inference internals leaked), `emptyUsageTotals`, `DATA_DIR`, and the TUI/hook internal types
   (`ClusterViewCtx`, `SectionOp`, `ClaudeMdLayer`, …). → drop the `export` (or delete) where truly unused.

4. **`sensePrFacts` / `src/pr-sense/`** — flagged dead by this audit AND evicted-to-cluster by ADR-0063. →
   deleted there; noted here so the two ADRs don't collide.

## Decision

Delete the two legacy liveness modules and prune the dead exports, **each after a grep confirms zero live
callers** (the audit's list is the starting point; verify at implementation time in case something was
wired up since).

- **open-state.ts + live-by-cwd.ts:** delete outright. `cmux/liveness.ts` + the ADR-0054 bridge are the
  sole liveness path. This is what actually closes CI-2 — the fail-open path is *gone*, not merely unused,
  so it can't be reintroduced by a stray import.
- **Dead exports:** for each, either remove the symbol (if nothing uses it at all) or drop just the `export`
  keyword (if it's used only within its file). Genuine extension points (e.g. a hook plugin type) get an
  `@internal` tag instead of removal — but the audit found these are implementation details, not a plugin
  API, so default to removal.
- **Guard against regrowth:** a lint/CI check for unused exports (e.g. `knip`/`ts-prune`) so the surface
  doesn't re-bloat.

## Why not debatable

- Both modules declare *themselves* superseded in their headers; the replacement (`cmux/liveness.ts`)
  shipped with ADR-0040/0054. Keeping them is pure risk (the fail-open path) with zero benefit.
- Dead exports are, by definition, unreferenced — removing them changes no behavior; it only shrinks the
  API surface the audit flagged as confusing.
- The only care needed is verify-before-delete, which the implementer does per-symbol.

## Consequences

- Delete `open-state.ts`, `live-by-cwd.ts` (+ their tests). Repoint any lingering non-liveness reference
  (e.g. a column-label comment) to neutral wording.
- Prune 84 exports (or `@internal` the few genuine seams). Add an unused-export linter to CI.
- CI-2 fully closed: liveness has exactly one path, fail-closed, no legacy fail-open module to guard.
- Pairs with ADR-0063 (pr-sense deletion) — same "delete the superseded thing" pass.
