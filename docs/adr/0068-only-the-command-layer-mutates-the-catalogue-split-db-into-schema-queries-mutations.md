# Only the command layer mutates the catalogue; split db.ts into schema / queries / mutations

Decided with Milad 2026-07-11 from the module-boundary audit. Makes "the catalogue is mutated through one
door" an enforced architectural boundary, not a convention. Sequenced AFTER the schema-changing ADRs
(0057/0060/0062) so the mutation surface is split once, not twice.

## The problem

`src/catalogue/db.ts` (693 LOC) exports ~42 functions mixing four concerns: migrations, read queries
(`sessionsForRole`, `getRow`, `lifecycleOf`), write mutations (`setRole`, `setStage`, `stampPrFacts`, …),
and lifecycle helpers. Because every mutation is exported from the data module, any caller — a hook, the
engine bridge, a stray command — can mutate the catalogue directly, bypassing the command layer
(`commands.ts`) that is supposed to own writes (validation, stamping `updated_at`, enforcing invariants).
The mutation surface is wide (42 exports) and unauditable for who-writes-what.

## Decision

**Mutating the catalogue goes through the command layer. The data layer exposes reads freely and mutations
only to that layer.** Concretely:

1. **Split `db.ts` by concern:**
   - `db-schema.ts` — `openCatalogue`, the migration chain, `CatalogueRow` type, `hasColumn`.
   - `db-queries.ts` — read-only: `getRow`, `getAll`, `sessionsFor*`, `lifecycleOf`, `identityKeyOf`, tag
     reads. Freely importable anywhere.
   - `db-mutations.ts` — writes: `set*`, `touch`, `stampPrFacts`, `setMeta` (post-0060), tag writes.

2. **Restrict who imports `db-mutations`.** The command layer (`commands.ts` and the generic setters from
   ADR-0064) is the only sanctioned importer. Enforce it — a lint rule / import-boundary check (e.g. an
   eslint no-restricted-imports or a dependency-cruiser rule) that fails the build if anything outside the
   command layer imports `db-mutations`. Queries + schema stay unrestricted.

3. **Engine/sensor writes go through the same door.** The pr-watch engine doesn't mutate the catalogue by
   importing `set*` — it uses the ccs CLI (`ccs meta`, `ccs stage`, the generic setters) or a sanctioned
   command entry, so the single-writer + validation guarantees (ADR-0064) apply uniformly. The tool↔config
   boundary (ADR-0058) already implies this; this makes it structural.

## Why enforced, not just tidy

- **It's the seam that makes the guarantees real.** ADR-0064 puts validation/monotonic/lock enforcement in
  the setters; ADR-0031 mandates single-writer-per-field. Both are defeated if a caller can reach past them
  to a raw `set*`. An *enforced* boundary is what guarantees every write is validated + stamped.
- **Auditability:** "who can change the catalogue" becomes a one-line answer (the command layer), not "grep
  42 exports."
- Milad's call: enforce it (ADR), not a cosmetic reorg.

## Consequences

- **Sequencing:** do this AFTER ADR-0057 (work-unit attrs), 0060 (meta column + retire milad/build columns),
  0062 (drop kind/resume_command columns). Those rewrite the mutation surface; splitting first = double work.
- Three files replace `db.ts`; imports across the codebase update (queries/schema mostly unchanged callers;
  mutation callers outside the command layer get repointed through commands — surfacing any current
  boundary violations).
- Add the import-boundary lint to CI so the boundary can't erode.
- Pairs with ADR-0065 (catalogue↔resume cycle) and ADR-0067 (dead-code lint) as the "module boundaries are
  enforced, not aspirational" pass.
