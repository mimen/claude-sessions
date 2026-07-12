# A cluster declares its grouping type

Decided with Milad 2026-07-11. The follow-up ADR-0059 deferred: making "grouping is general, epic is a
type" real, so a cluster declares which grouping type it uses instead of `epic` being assumed platform-wide.
Sibling of ADR-0069 (work-unit anchor types) — same generic-concept/typed-variant pattern (ADR-0061), kept
as its own ADR per Milad.

## The problem

ADR-0059 established that **grouping** is the platform concept and **epic** is the *type* pr-watch uses —
but nothing yet lets a cluster *declare* its grouping type. The `epicId` FK and the display metadata
(label/url/shortName/notes, `state/groupings.ts`) still carry the `epic` assumption. A second cluster whose
mid-level grouping is a milestone, a campaign, or a customer would inherit "epic" vocabulary that doesn't
fit.

## Decision

**A cluster declares its grouping type in cluster config; the platform stores the grouping generically and
renders it by the declared type.**

```toml
# cluster.toml (pr-watch)
grouping_type = "epic"        # pr-watch's mid-level grouping is a GUS epic
# another cluster:
# grouping_type = "milestone"
# grouping_type = "campaign"
```

1. **The grouping entity stays generic** (ADR-0051/0059): a session references it by FK; label/url/
   shortName/notes live in **cluster state**. The tool stores + returns it and does not know what an "epic"
   is.

2. **The type is the cluster's label + rendering hint**, not new storage. `grouping_type` drives: the word
   shown in the UI ("Epic" vs "Milestone"), how the cluster's **sense** step populates the grouping's
   attributes (e.g. from a GUS epic query vs a milestone API), and any type-specific display. It does NOT
   change the generic FK or store shape — same entity, cluster-supplied vocabulary. This is the exact
   ADR-0061 split at the grouping layer.

3. **The FK naming generalizes.** `epicId` → `groupingId` (the reference is to a grouping of the cluster's
   declared type), folded into the ADR-0059 rename work. The value is still an opaque id; only the label is
   typed.

## Consequences

- `cluster.toml` gains `grouping_type` (string). Loader surfaces it; the renderer + `sense` step read it.
- `epicId` FK → `groupingId` (part of the ADR-0059 naming pass; additive migration, backfill).
- `state/groupings.ts` is already generic (Grouping = label/url/shortName/notes) — no shape change; it gains
  a per-cluster `type` from config, used for display/sensing, not storage.
- pr-watch sets `grouping_type = "epic"` and keeps its current behavior; the platform stops assuming "epic"
  anywhere.
- Deliberately minimal: like ADR-0069's built-in anchor types, we don't build a plugin registry for
  grouping behaviors now — the type is a declared label + sensing/render hint. If a cluster needs
  type-specific *logic*, that lives in its engine (config-side), not the tool.
- Glossary: **grouping** = generic entity; **grouping type** = cluster-declared (pr-watch = epic); `epicId`
  is now `groupingId`.
