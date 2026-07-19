# Generic metadata commands with role-declared schemas replace hardcoded cluster verbs

Decided with Milad 2026-07-11. Establishes the CLI half of the ADR-0060 generic **meta** map: the tool
ships generic setters for arbitrary session metadata (statuses, activity, locks), and the *allowed values /
schema* for those fields are declared in `role.toml`. Replaces the hardcoded pr-watch verbs (`ccs ready`,
`ccs approve`) with generic primitives + cluster-provided wrappers. Instance of ADR-0061, built on ADR-0060
(meta map) and ADR-0062 (role declares its properties).

## The problem

pr-watch's workflow verbs are baked into the platform CLI (`src/catalogue/commands.ts`): `ccs ready` hard-
codes the transition to `"milad-review"`, `ccs approve` sets `milad_review`, `ccs activity` hardcodes the
`needs-you` vocabulary. These are cluster semantics in the platform binary — a second cluster can't add its
own status/activity/lock verbs without a tool change, and it inherits pr-watch's.

Milad's framing of the fix: there should be **general commands that set the arbitrary metadata we use for
locks / statuses / activity, whose allowed values are configurable from `role.toml`.**

## Decision

1. **The tool ships generic metadata setters** over the ADR-0060 fields:
   - `ccs stage <selector> <value>` — set the blessed **stage** column.
   - `ccs activity <selector> <value> [--off]` — set the blessed **activity** column.
   - `ccs meta <selector> <key> <value> [--off]` — set/clear a key in the generic **meta** map (statuses,
     locks, buildComplete, miladReview, any cluster-defined field).
   These are the *only* metadata-writing verbs the platform owns. They're vocabulary-agnostic: the tool
   stores the string, it does not know what `milad-review` or `needs-you` mean.

2. **`role.toml` declares the schema for those fields** — the allowed values and shape, so the generic
   setters can validate:
   ```toml
   [meta.stage]        # constrains the blessed stage column for this role
   values     = ["building", "milad-review", "in-review", "approved", "merged"]
   monotonic  = true                      # ccs enforces forward-only (a behavioral guarantee)

   [meta.activity]
   values     = ["needs-you", "fixing"]   # (absent = the resting/dormant baseline)
   clears_on_stage_change = true

   [meta.keys.milad_review]   # a meta-map key
   values     = ["approved"]              # or type = "bool" / "string" / "lock"
   writer     = "human"                   # who may set it (worker | engine | human) — advisory/enforced

   [meta.keys.lock]
   type       = "lock"                    # a lock field: presence = held; ccs can enforce single-holder
   ```
   The tool reads this to (a) **validate** a generic set against allowed values, (b) apply the declared
   **behavioral guarantee** (monotonic, clears-on-transition, single-writer/lock), and (c) reject an
   out-of-vocabulary or out-of-role write with a clear error. The *vocabulary* is the cluster's; the
   *enforcement* is the tool's — the ADR-0061 split, exactly.

3. **Cluster-specific verbs become thin wrappers in cluster config**, not platform commands. `ccs ready`
   and `ccs approve` are provided by the **pr-watch cluster** as commands (they already live in
   `.ccs-config`) that call the generic setters:
   - `ready` → `ccs stage . milad-review` (allowed because role.toml lists it + monotonic guard permits it).
   - `approve` → `ccs meta <pr> milad_review approved`.
   The platform CLI drops `ready`/`approve`; `stage`/`activity`/`meta` replace the pr-watch-specific
   `setMiladReview`/`setStage`-with-hardcoded-value logic.

4. **Locks are just a declared meta field.** Milad's "metadata we use for locks" — a role declares a meta
   key of `type = "lock"`, and `ccs meta <sel> <lock-key> <holder>` with the single-holder guarantee gives
   a first-class, cluster-defined lock primitive with zero lock-specific platform code. (Ties to the
   mergeFields single-writer story, ADR-0031/0060.)

## Why role-declared schema, not free-form

A pure free-form `ccs meta set anything` would work but throws away the guarantee that makes platform
storage worth more than a scratch file: **validation + behavioral enforcement.** Declaring the schema in
`role.toml` lets the tool enforce "stage only moves forward," "activity is one of these," "this lock has one
holder," "only the engine writes this field" — determinism properties a cluster couldn't enforce itself.
It also makes the metadata surface *self-documenting per role* (the ADR-0062 role-properties block already
exists; this extends it), and it's what the rendering rules (ADR-0060) and the `meta-update` hook (which
already declares which fields a role refreshes) key against. Free-form where you want it (a plain `string`
key with no `values`), constrained + guaranteed where it matters.

## Consequences

- **CLI:** add `ccs stage` / `ccs activity` / `ccs meta` generic setters (selector-driven, consistent with
  `ccs resume <selector>` — ADR shared selector, S18). Remove `ccs ready` / `ccs approve` from the platform;
  re-provide as pr-watch cluster commands. `ccs activity` stays but becomes vocabulary-agnostic (validates
  against role.toml, not a hardcoded `needs-you`).
- **role.toml:** gains a `[meta.*]` schema block (values, monotonic, clears_on_stage_change, writer, lock
  type). Loader (`role-files.ts`) surfaces it; the generic setters consult it to validate + enforce.
- **db.ts:** `setStage`/`setActivity`/`setMeta` become the write primitives; `setMiladReview`/hardcoded
  transitions retire (per ADR-0060). Enforcement (monotonic/lock/writer) wraps these writes, driven by the
  role schema.
- **Validation errors are actionable:** "stage 'foo' not allowed for role pr-agent (building | milad-review
  | …)"; "stage can't move merged→building (monotonic)"; "lock 'deploy' already held by <sid>".
- **A new cluster gets workflow verbs for free:** declare the vocabulary + guarantees in role.toml, add thin
  cluster command wrappers — no tool change. The event-watch test again.
- **CHANGELOG (ADR-0058):** `ccs ready`/`ccs approve` moving from platform to cluster commands, and
  `ccs meta` arriving, are behavioral changes for agents — prescriptive entries.
- **Glossary/units:** add **meta command** (generic setter) and **field schema** (role-declared allowed
  values + guarantees); note locks are a declared meta field, and `ready`/`approve` are cluster wrappers.
