# Incognito is a session column, and the guarantee is "no listing at all"

Decided 2026-08-09.

## Context

ccs already had two ways to make a session recede: `archived` and `session_class = auxiliary`. Both are *display defaults* — `ccs ls --all` shows archived rows, `--auxiliary` shows delegated seats. Neither addresses the reason someone would want a session out of sight, which is not tidiness but content. A session about compensation, health, a legal question, or an unannounced decision should not appear in a shared screen share, and more importantly should not have its transcript read by anything.

Three code paths carry one session's content somewhere else, and they are the actual exposure:

- `src/enrich/gateway.ts` POSTs a transcript tail to the local model gateway, which forwards it to a model provider. Content leaves the machine.
- `resolvePredecessors` (`src/catalogue/lineage.ts`) offers a past session's transcript path to a *different* session rehydrating the same identity.
- `readSessionsSince` (`src/enrich/world.ts`) composes a count and a most-recent id into another session's prompt.

The obvious implementation — a `session_tags` entity like `domain:` tags — was rejected on inspection: no listing path in ccs reads `session_tags`, so a tag would have had to be joined into every consumer anyway, at which point it is a column with extra steps and a silent failure mode when a consumer forgets the join.

`catalogue` version 41 was already reserved by an in-flight enrichment branch that drops the `enrichment_*` columns. Stamping past it would make that branch's `v < 41` check false on a live store and silently skip a drop it believes it performed.

## Decision

`catalogue.incognito` is an `INTEGER NOT NULL DEFAULT 0` column with a partial index on the marked rows, added **off the version ladder** behind a `hasColumn` presence guard, following the `enrichment_declined` precedent already in `db-schema.ts`. `CATALOGUE_VERSION` stays at 40.

The exclusion is **unconditional everywhere**. There is no `--all` for incognito, no `IncludeIncognito` option on the Go TUI's `LoadOptions`, no reveal flag on any surface. `archived` is a default you can override; incognito is a guarantee, and a reveal flag would make it the former.

Aggregate counters are covered too, not just row rendering. The `ccs ls` footer reports `rows.length - shown` as "N hidden … `--all` to show", and the Go dashboard sums `Spend` over raw index rows. Both would announce that something exists while pointing at a flag that does not reveal it, so incognito rows are removed from the denominator rather than skipped at render time.

The restriction is on what leaks **out of** a marked session, not on what it can see. `predecessorsOf` filters the sibling, never `self`: an incognito session still reads its own non-incognito lineage.

Marking is available at birth (`ccs session new --incognito`) and after the fact (`ccs session incognito .`). Marking after the fact also clears any stored enrichment, because that is the half of the leak still undoable locally.

## Consequences

- A session marked at birth is never seen by the enrichment sweep, so no turn of it is ever sent to a model provider. This is the only airtight path, and the CLI and slash command both say so.
- A session marked mid-run may already have been summarized and sent. `markIncognito` clears the stored row; what left the gateway cannot be recalled.
- Un-marking is not a restore. The cleared enrichment stays cleared.
- An incognito session is excluded from `ccs doctor sessions` birth-integrity auditing, because every finding that report emits carries the session id, project, and title. A marked session is not audited — that is the cost the guarantee charges.
- When the catalogue is unreadable, the sidebar cannot filter, because the catalogue is the only record of which sessions are marked. This degrades identically to the existing auxiliary exclusion and is a broken-machine state, not a routine one.
- The enrichment branch that owns v41 lands unaffected; this column carries no version stamp to collide with.
