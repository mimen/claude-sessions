# A grouping (epic) is authored context (config) + sensed/accumulated metadata (runtime); the platform holds a generic grouping, not a GUS epics table

Supersedes ADR-0039 (epic-as-entity lives in ccs / epic-as-operation is cluster state) with a
cleaner split. Also carries the amend-materialization note for ADR-0034. Decided with Milad
2026-07-10.

## The problem

The platform hardcoded an `epics` table (`name`, `url`, `short_name`) written by pr-watch's
GUS sensor. That leaks a cluster-specific concept (a GUS epic) into the generic platform schema.
As Milad put it: it's basically a GROUPING, and "we use GUS" is a configuration detail — for
personal projects the grouping might be tracked in GitHub milestones or elsewhere. Yet the
browsing experience (a clickable epic with label + URL in the ccs TUI and statusline) must NOT
be lost.

## Decision — "A": restructure now, keep the name "epic"

- **`epicId` stays a GENERIC grouping axis** in the platform (the `epic` level in the hook
  resolver, the `epic_id` row field). The platform knows "a session can have an optional
  mid-level grouping"; it does NOT know the grouping is a GUS epic. The word "epic" is kept; a
  future rename to "grouping" is deferred (cheap, cosmetic).
- **A grouping has five parts, split by who authors them and when:**
  | part | source | home |
  |------|--------|------|
  | project-wide **context** | human-authored | CONFIG (the grouping's `.ccs-hooks/claude-md.md`) |
  | **name** (full), **link** | sensed from a tracker via a cluster ADAPTER (GUS for pr-watch) | RUNTIME (`~/.ccs` cluster state) |
  | **shortname** | ccs-derived from name, hand-overridable | RUNTIME |
  | **notes** | agent-accumulated project memory | RUNTIME |
- **The hardcoded `epics` table is demoted to cluster runtime state.** The cluster's adapter
  (pr-watch's GUS sensor) writes name/link into `~/.ccs/clusters/<c>/…`; the TUI + statusline
  read a GENERIC `{label, url}` slot. The clickable-epic experience survives untouched — it's
  reading the generic slot, not a GUS-shaped table.
- **A grouping has context, not full hooks.** By file-presence (ADR-0043) a grouping that ships
  only a `claude-md.md` naturally contributes context and nothing else — no restriction code
  needed.
- **Notes are a project-level memory** — the initiative analogue of predecessor rehydration
  (ADR-0038). An agent learns something project-wide, appends it to the grouping's notes; every
  future session under that grouping gets it via the epic-level `claude-md` composition
  (authored context + accumulated notes). Promoting a note to permanent context is a deliberate
  human edit (runtime note → config context).

## Consequences

- The generic renderer stops taking a platform `EpicRow` and takes `{label, url}` the cluster
  supplied into runtime state — GUS becomes one adapter behind a seam, not a platform concept.
- Supersedes ADR-0039's table-in-ccs framing; the entity metadata is cluster runtime, the
  authored context is config, and the axis stays generic.
- Amends ADR-0034: materialization is re-sourced from the config package files (ADR-0048/0051),
  not the dropped sqlite tables.
