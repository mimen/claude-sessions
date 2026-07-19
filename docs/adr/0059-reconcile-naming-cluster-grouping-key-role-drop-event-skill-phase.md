# Reconcile the naming: cluster, grouping(+type), key, role — and drop event, skill, phase

Decided with Milad 2026-07-11 from the glossary's naming-debt list (writing every unit in one vocabulary
surfaced these). Pays down the inconsistencies that made the model read in two languages. Touches the
catalogue schema (ADR-0048/0049), so the removals are migrations the tool owns (ADR-0058 tool↔state rule),
not bare drops.

## The decisions

1. **cluster > system.** The operation-level grouping is **cluster** everywhere. `system` was only ever the
   DB column name (`sessionsForSystem`, `--system`, `setSystem`) while UI/CLI/docs said cluster — the
   biggest split (44 files). Rename the column + all functions/flags to `cluster`. Canonical: **cluster**.

2. **grouping is the general term; epic is a TYPE of grouping.** A **grouping** is the generic mid-level
   work grouping; **pr-watch uses an epic-type grouping**. So grouping is not renamed *to* epic nor epic
   *to* grouping — grouping is the platform concept, and a grouping has a **type** (pr-watch's is `epic`).
   This is the same shape as the work-unit anchor-type idea (ADR-0057 follow-up): a generic concept with
   typed variants a cluster picks. The schema FK stays generic; drop the `epic`-specific naming from the
   platform layer and let the *type* carry the "epic" meaning.

3. **key > event (remove event).** **key** is canonical; **event** is the dead alias. Remove the `event`
   column, `setEvent`, `sessionsForEvent`, `--event`, and the `key ?? event` fallback read.

4. **role > skill (remove skill).** **role** is canonical (ADR-0015); **skill** is the dead alias. Remove
   the `skill` column, `setSkill`, `--skill`, and the `role ?? skill` fallback read.

5. **Get rid of phase.** **phase** was superseded by **stage** × **activity** (v19, ADR-0019). Remove the
   `phase` column, `setPhase`, `--phase`, the `phase` command, and the legacy `phase` render fallback.

## What "remove" requires (verified against the live catalogue — not a bare DROP)

A live check (`~/.ccs/cache/catalogue.db`) shows removal would lose data / break reads unless migrated:
- **skill:** 1 row is skill-only (`role IS NULL AND skill IS NOT NULL`). The v12 backfill (`role = skill`)
  ran once at migration time; rows written since can miss it. → **Re-backfill `role` from `skill` first**,
  then drop.
- **event:** 0 event-only rows. → backfill `key` from `event` (belt-and-suspenders), then drop. Safe.
- **phase:** 14 rows still carry `phase`, and `render-statusline.ts:80` still reads `row.phase`. → the
  renderer must move fully to **stage × activity** BEFORE the column goes; phase values are legacy display
  only (no clean backfill to stage — it's free-form), so this is a reader migration + drop, accepting that
  old rows lose their free-form phase string (they render from stage/activity going forward).

So each removal is a **migration with three steps in order**: (a) re-backfill the canonical column, (b) move
every reader off the dead column, (c) drop the column (a new catalogue migration version). The index DB is a
pure cache and just rebuilds; the catalogue is the one that migrates in place.

## Consequences

- **Migrations (tool-owned, ADR-0058):** new catalogue versions — re-backfill role←skill and key←event,
  then DROP `skill`, `event`, `phase`. Update `CatalogueRow`, all `sessionsFor*`/`set*` accessors, and the
  CLI (`--system`→`--cluster`, remove `--event`/`--skill`/`--phase` + the `event`/`skill`/`phase` commands).
- **cluster rename is the big mechanical one (44 files):** `system` column → `cluster`, `sessionsForSystem`
  → `sessionsForCluster`, `setSystem` → `setCluster`, `--system` → `--cluster`. `ccs cluster <c>` already
  reads right; this makes the internals match the surface.
- **grouping/epic:** keep the generic `epicId` FK's *purpose* but reframe it as a grouping reference with a
  type; the platform speaks **grouping**, the pr-watch cluster configures an **epic**-type grouping. (Full
  generalization — a grouping-type registry — pairs with the ADR-0057 follow-up on typed work-units; this
  ADR just removes the assumption that "grouping == epic" at the platform layer.)
- **CHANGELOG entries (ADR-0058):** these are behavioral/vocabulary changes agents must adopt — every
  removed command/flag (`ccs phase`, `--event`, `--skill`, `--system`) needs a prescriptive changelog entry
  so the catch-up hook can carry running agents across the rename ("`ccs phase` is gone; use `ccs ready` /
  `ccs activity`"; "`--system` is now `--cluster`").
- **Glossary/docs:** drop the alias flags for these four; the naming-debt box shrinks to just the
  work-unit-drift item (handled by ADR-0057). The shared vocabulary becomes real: one term per concept.
- **Ordering:** do the reader migrations + backfills before the drops; sequence the `phase` renderer move
  ahead of its column drop. Safe to land the four independently; `cluster` rename is isolated mechanical
  churn best done in one pass.
