# Epic-as-ENTITY lives in the ccs catalogue; epic-as-OPERATION is pr-watch cluster state

> **Superseded by ADR-0051 (2026-07-10).** A grouping's entity metadata (name/link/shortname)
> is cluster RUNTIME state written by a cluster adapter (GUS is one adapter, not a platform
> concept); its project-wide CONTEXT is config; `epicId` stays a generic grouping axis. The
> hardcoded `epics` table is demoted out of the platform schema.


Milad asked where "epic context" lives (2026-07-09). "Epic" means two different things, and
they land in two different scopes of the model. Naming the split prevents the same
overload that ADR-0013 had to untangle for work-unit identity.

## The two meanings of "epic"

1. **Epic as ENTITY** — the epic's identity: its name, short-name, URL, GUS sfId, and which
   sessions belong to it. This already exists as a **first-class ccs catalogue entity**: an
   `epics` table + an `epic_id` FK on session rows, which is how the TUI groups by epic
   today. It is an IDENTITY fact, not operational state — the same kind of durable,
   cross-cluster-safe fact as a session's role or work-unit.

2. **Epic as OPERATION** — pr-watch's working knowledge OF the epic: which WIs belong to it,
   what's startable next, dependency/gating between its PRs, "reviewed/flagged" status, the
   cross-PR picture control uses to suggest the next work. This is **pr-watch cluster state**
   (`~/.ccs/clusters/pr-watch/`, ADR-0031), alongside board/gate/dispositions. It is
   pr-watch-specific and meaningless to another cluster.

## Decision — split on entity vs. operation

- **Epic-as-entity → ccs catalogue.** The epic entity + a session's membership in it are ccs
  facts (already built). A worker reads its own epic membership from its identity metadata;
  the display surfaces render the epic short-name from it (§6).
- **Epic-as-operation → pr-watch cluster state.** The epic plan (startable-next, gating,
  cross-PR status) lives in the cluster state dir and is written/read by pr-watch's control
  role. ccs does not model it.

This is exactly the ADR-0025 line applied to epics: identity/entity facts in ccs core;
cluster-shaped operational state in the cluster dir. It also mirrors ADR-0013's work-unit
resolution — the stable entity fact (epic id, like gus_work) is ccs's; the operational
interpretation is the cluster's.

## Why not put the whole epic in one place

- **All in ccs:** would force ccs to model pr-watch's epic-operational semantics (startable,
  gating) — the mechanism-vs-policy coupling ADR-0010 warns against. Another cluster's
  "epic" (event-watch) has totally different operational meaning.
- **All in pr-watch:** would duplicate the epic entity ccs already owns and break the TUI's
  cross-cluster epic grouping. The entity is genuinely shared infrastructure.

## Consequences

- "Epic context" is disambiguated: entity facts (name/short/url/membership) come from ccs;
  the operational plan comes from pr-watch cluster state. A reader/implementer knows which
  to touch.
- The identity key's optional epic prefix (ADR-0030) is derived from the ccs epic ENTITY
  (short-name), not from the operational state — consistent with "epic entity is ccs's."
- event-watch reuses the epic entity if it has an analogous grouping, and keeps its own
  operational state in its own cluster dir.
