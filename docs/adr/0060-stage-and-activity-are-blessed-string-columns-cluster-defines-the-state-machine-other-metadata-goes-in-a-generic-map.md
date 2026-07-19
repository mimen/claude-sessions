# stage & activity are blessed string columns; the cluster defines the state machine; other role-specific metadata lives in a generic map

Decided with Milad 2026-07-11. Resolves the layering violation where pr-watch-specific columns
(`milad_review`, `build_complete`, and the *values* of `stage`/`activity`) were baked into the platform
**catalogue** schema. Sits on the ADR-0058 tool↔config contract (rendering rules iterate in config) and is
the third instance of the ADR-0061 generic-mechanism / cluster-vocabulary principle (companion ADR).

## The problem

The **CatalogueRow** schema encodes one cluster's vocabulary. `stage`/`activity` have pr-watch values
baked into renderers; `milad_review` and `build_complete` are pure pr-watch semantics sitting as dedicated
columns. A second cluster (e.g. `event-watch`) would inherit `milad_review`/`build_complete` columns it
never uses, and adding a new role-specific field means a schema migration. That's the platform schema
speaking a cluster's language — the same smell fixed for work-unit (ADR-0057) and grouping (ADR-0059).

But the fix is NOT uniform, because two different things were conflated:
- **`stage` / `activity` are genuine primitives** — "a monotonic pipeline position" and "a transient
  sub-status" are general shapes many roles want, and ccs should *display them as columns*.
- **`milad_review` / `build_complete` are not primitives** — they're pr-watch scratch state for its state
  machine, with no general meaning.

## Decision

1. **`stage` and `activity` stay as first-class, blessed string columns on the CatalogueRow.** They are
   just strings — ccs stores and *displays* them (tab **pill**, **statusline**, `ccs cluster` view) but does
   NOT define their vocabulary or transitions. Many roles across many clusters will have a stage and an
   activity, and we want them as real columns so they're queryable and renderable platform-side. ccs's only
   semantic contribution is the two *shapes*: **stage** is treated as monotonic/latched-friendly, **activity**
   as transient (cleared on stage change) — but even that is advisory; the authority is the cluster.

2. **The cluster/role defines the state machine** — the allowed **stage** values, the legal transitions,
   which **activity** values exist, and when activity clears. This lives in **cluster config** (`.ccs-config`),
   iterated while you work (ADR-0058). ccs enforces nothing about the *values*; it's a string field. (If we
   later want ccs to enforce monotonicity, that's an opt-in the cluster declares — not assumed.)

3. **Everything else role-specific goes in a generic per-session metadata map** — a JSON field on the
   CatalogueRow (`meta`, a `Record<string, unknown>`). `milad_review`, `build_complete`, and any scratch a
   role's state machine needs (a latch, a counter, a sensed flag) are keys in this map. ccs stores, stamps,
   and returns it but does **not interpret** it. Adding a field is a map write, not a schema migration. This
   is where the state machine's additional storage lives.

4. **Rendering reads both** — the platform renderer becomes generic: `stage + activity + meta + the
   cluster's render rules → pill/tab`. The render rules (which meta keys matter, how they map to a pill)
   are cluster config, not hardcoded in `render-tab.ts`.

5. **The pr-watch verbs move off the platform CLI.** `ccs ready` / `ccs approve` / `ccs activity` are
   pr-watch semantics currently baked into `src/catalogue/commands.ts`. They become cluster-provided
   commands (they already live in `.ccs-config`) that write `stage`/`activity`/`meta` via a generic setter
   (e.g. `ccs stage <v>`, `ccs activity <v>`, `ccs meta <key> <value>`). ccs ships the generic primitives;
   the cluster ships the verbs.

## Why this split (and not the alternatives)

- **Why keep stage/activity as columns, not fold them into the map:** they're near-universal across roles
  and we want them displayed as real columns (queryable, first-class in the cluster view). Burying them in
  JSON would make the one thing every role shares invisible to the platform. Milad's call: "a lot of roles
  will have/need these and we want them displayed in ccs as columns."
- **Why a map for the rest, not more columns:** avoids "messy sprawl of columns" as clusters/roles multiply.
  The map is the state machine's scratch space — populated with whatever a session needs, looked up as
  needed. The driver is NOT "fewer migrations" (a cluster invents a field rarely); it's *not encoding one
  cluster's vocabulary in the platform schema* so a second cluster inherits a clean row.
- **Existing seam this extends:** the **meta-update** hook already declares, per **level**, *which fields* a
  role refreshes (a set-union of field names, ADR-0044). "The set of metadata fields is role-configurable"
  is already a concept in the hook layer — this reaches it down into storage (the map) instead of stopping
  at hardcoded columns.

## Consequences

- **Schema:** add a `meta` JSON column to CatalogueRow; **keep** `stage`/`activity` (now documented as
  cluster-defined strings, not pr-watch enums). **Migrate** `milad_review` + `build_complete` into `meta`
  (backfill their values into `meta.milad_review` / `meta.build_complete`, then drop the columns — a
  tool-owned migration, ADR-0058). This pairs with the ADR-0059 `phase` drop.
- **Renderer:** `render-tab.ts` / `render-statusline.ts` stop hardcoding pr-watch stage values and
  milad/build logic; they consume cluster render rules + `stage`/`activity`/`meta`. The pr-watch pill logic
  moves into pr-watch config.
- **CLI:** add generic `ccs stage` / `ccs activity` / `ccs meta <key> [value] [--off]` setters; retire
  `ccs ready`/`ccs approve` as platform commands (re-provide as pr-watch cluster commands that call the
  generic setters). Changelog entry (ADR-0058) carries agents across it.
- **db.ts accessors:** `setStage`/`setActivity` stay; `setMiladReview`/`setBuildComplete` become
  `setMeta(key, value)` / `getMeta(key)`. `CatalogueRow.miladReview`/`buildComplete` become
  `row.meta.milad_review` etc.
- **Roles declare what they use** (ties to the ADR-0057 role-properties follow-up): whether a role has a
  stage machine, and which meta keys it reads/writes — so the meta map isn't a free-for-all but a declared
  surface per role.
- **Cost accepted:** meta is JSON (json_extract to query, no column index). Fine — these are per-session
  *display/scratch* state, read all-at-once for rendering, not grouping axes. stage/activity stay indexed
  columns precisely because they ARE displayed/queried broadly.
- **Glossary/units:** update — **stage**/**activity** = blessed cluster-defined string columns;
  **miladReview**/**buildComplete** = examples of **meta** keys, not schema fields; add **meta** (generic
  per-session map) and **state machine** (cluster-defined stage/activity rules) as terms.
