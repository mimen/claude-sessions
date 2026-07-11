# ccs durable-state storage contract — file-backed, cluster-scoped, versioned, atomic, single-writer-per-field

ADR-0025 decided ccs owns all durable state at two scopes (identity/role + cluster),
generally across clusters — and event-watch is a real, imminent second consumer (Milad
2026-07-09), so the generalization is justified, not premature. But both design reviews
warned that a general "ccs owns all state" is only safe if bounded by a concrete storage
contract; otherwise ccs becomes an unspecified opaque store. This ADR is that contract:
the HOW for 0025's WHAT. Decided with Milad 2026-07-09.

## Decision — the boring, explicit substrate

State is **file-backed JSON**, and ccs owns the location, the write discipline, and the
verbs. Systems supply the SHAPE of their state; ccs does not impose a schema on the
contents.

### Layout (two scopes, ccs-owned paths)

- **Identity/role state** — keyed by responsibility (ADR-0026/0030):
  - `~/.ccs/identities/<cluster>/<role>/[<epic>/]<work-unit>/`
    - `inbox/`, `processed/` (ADR-0033)
    - `result.json`, `judgment.json` (the identity's own memory/output)
  - core singletons omit the work-unit: `~/.ccs/identities/<cluster>/<role>/`
- **Cluster shared state** — one dir per cluster, JSON blobs whose shape is the cluster's:
  - `~/.ccs/clusters/<cluster>/` → `board.json`, `gate.json`, `dispositions.json`, …
  - ccs owns the dir + the write discipline; it does NOT define what's inside (Milad
    2026-07-09: "ccs owns path + locking; shape is pr-watch's").

The session catalogue itself stays in its existing sqlite db (identity rows, PR-sense,
phase). This ADR governs the *state store* (inbox, result, judgment, cluster blobs), not
the catalogue. The two coexist: sqlite for the queryable session index, JSON files for
the per-responsibility + per-cluster state.

### Write discipline

- **Atomic writes.** Every write is write-to-temp + `fsync` + atomic `rename` over the
  target. A reader never sees a half-written file; a crash mid-write leaves the previous
  version intact.
- **Version field.** Every JSON document carries a `schemaVersion`. ccs reads
  known versions and refuses / migrates unknown ones explicitly — no silent
  best-guess parsing.
- **`updated_at` + source on every document.** Each write stamps `updated_at` and the
  writer's identity. This is what lets the display render staleness (ADR-0035) instead of
  faithfully rendering stale lies — a reader can see "this is 40 min old, from control."
- **Single-writer-per-field** (carries ADR-0004/0005 forward). A field/blob has exactly
  one owning writer. Cross-writer coordination uses reserved sub-objects (the concierge
  lane pattern, ADR-0004), never a free-for-all on one file. Where two writers genuinely
  must touch one document, they own disjoint keys within it.
- **No lock manager in v1.** Single-writer-per-field + atomic rename is the concurrency
  model; there is no CAS/lock service. The one place concurrent access is unavoidable —
  inbox drain by a possibly-doubled embodiment — is made safe by the drain protocol
  (ADR-0033) and the one-embodiment invariant (ADR-0032), not by locks here.

### Corruption / recovery

- A document that fails to parse or fails version check is quarantined (moved to
  `<name>.corrupt.<ts>`) and treated as absent; ccs logs and continues. A missing state
  file is not an error — it means "nothing yet." Callers must tolerate absence.

## Why file-backed JSON, not tables

- It's what pr-watch already uses; migration is "ccs owns the dir," not "rewrite every
  writer." Low risk, incremental.
- The shape is the system's and varies per cluster (board means nothing to event-watch);
  forcing it into ccs-defined tables would couple ccs to each system's model — exactly
  what 0010 (mechanism vs policy) warns against.
- Atomic rename + single-writer-per-field gives the durability guarantees that matter
  (survive reboot, never half-read, never drift) without a database's concurrency
  machinery, which the single-writer discipline makes unnecessary.

## Consequences

- 0025 stays general but is now bounded: "ccs owns all durable state" means "in this
  file-backed, versioned, atomic, owner-laned contract," not "an unspecified store."
- pr-watch's `~/.claude/pr-watch-2/` state dir migrates onto these paths; its writers keep
  their per-file shapes, gaining atomic-rename + versioning + `updated_at` where they lack
  it. `sessions.json`'s live-routing content is handled separately (see the retirement
  note tracked with the 0005 line — live-only routing may stay ephemeral, not in this
  durable store).
- event-watch, when it lands, uses the SAME layout and discipline with its own blob shapes
  under `~/.ccs/clusters/event-watch/` and its own work-unit under identities.
- Build: `ccs` gains the state I/O layer (atomic write, version check, quarantine) that
  the inbox verbs (ADR-0033) and cluster-state reads/writes sit on top of.
