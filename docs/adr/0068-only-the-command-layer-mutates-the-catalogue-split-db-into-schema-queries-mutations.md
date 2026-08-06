# Only sanctioned writers mutate the catalogue; database concerns are physically separated

The catalogue database has a strict dependency DAG:

```text
db-schema.ts <- db-queries.ts <- db-mutations.ts
```

New database modules import one another directly. There is no `catalogue/db.ts` compatibility barrel.

## Decision

The catalogue data layer is split by capability:

- `src/catalogue/db-schema.ts` owns schema and shared type exports, `openCatalogue`, migrations, and
  `hasColumn`. `hasTable` remains private. Identity, grouping, and inbox materialization imports stay lazy
  so opening the database does not add eager subsystem dependencies.
- `src/catalogue/db-queries.ts` owns unrestricted reads, hydration, derived read helpers, reverse lookups,
  tag reads, audit reads, display-title selection, and the role-resume cache. Its role-files dependency stays
  lazy.
- `src/catalogue/db-mutations.ts` owns raw row setters, tag writes, enrichment writes, audit writes, and the
  private `set` and `refreshDerivedKey` helpers. It depends only on schema and queries.

Query and schema imports are unrestricted. Production imports of `db-mutations.ts` are limited to the
explicitly justified writers in `src/catalogue/mutation-boundary.test.ts`. The same test scans `src/` and
`scripts/`, rejects imports through the removed barrel, bounds raw protected catalogue SQL, and prevents
sidebar request modules from constructing a writer.

## Sanctioned writers

The command layer remains the normal mutation door because it owns validation and stamping. A small set of
platform primitives also writes directly where routing through a CLI command would break the operation's
atomic boundary: session birth, delegated-child reservation, lifecycle heartbeats, enrichment persistence,
reviewed maintenance scripts, and generated benchmark fixtures. Each exception is named with its reason in
the enforcement test.

Sidebar snapshots are not exceptions. Request-path modules use readonly SQLite adapters and never import the
mutation module or call `openCatalogue`.

## Consequences

- A caller's import path states its capability: schema/open, unrestricted read, or raw mutation.
- Adding a raw writer requires changing the enforced allowlist with a reason.
- Catalogue-owned module cycles are eliminated without changing unrelated permission-mode, cluster, or CLI
  cycles.
- The split is physical only: SQL, migration order and guards, hydration, fallbacks, retry behavior, and write
  semantics remain unchanged.
