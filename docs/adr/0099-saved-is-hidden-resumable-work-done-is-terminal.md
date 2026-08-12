# Saved is hidden resumable work; Done is terminal

The session sidebar needs one state for work worth preserving without leaving it in the current
working set. The prior user-facing split between completion and archive did not express that intent:
both read as terminal, while neither named "keep this for later."

Decision: the user-facing lifecycle is **Active**, **Parked**, **Saved**, and **Done**.

- **Active** is the current working set.
- **Parked** is active work with an outstanding obligation or blocker. Saving and unsaving preserve
  its parked task so hiding a session never erases what is still owed.
- **Saved** is intentionally hidden from Active, retains its transcript and context, and remains
  explicitly resumable. Saving an open session closes its cmux workspace. A successful explicit
  resume clears Saved only after workspace creation succeeds; failed resume leaves it Saved.
- **Done** is concluded work. Resume refuses it until an explicit reopen clears completion.

The catalogue stores Saved separately from the existing `completed` and compatibility `archived`
columns. On first migration, historical archived rows become completed and the archive bit is
cleared; Saved starts empty. This prevents old discarded or junk sessions from silently populating
the new Saved view.

Historical `archive` and `unarchive` CLI inputs remain accepted as compatibility aliases for Done
and reopen. Enrichment's existing `archive` recommendation remains on its wire schema and maps to
Done. Neither path creates Saved work, and Archive is absent from sidebar and plugin vocabulary.

Fleet identities mirror Saved and Done because one fleet identity represents one work item. Core
identities do not mirror per-session lifecycle because multiple sessions may embody the same core
identity.

Consequences:

- Active, Saved, and Done are dedicated sidebar scopes; Saved and Done do not leak into Active.
- Cluster and automatic resume paths treat Saved as inactive and do not revive it implicitly.
- Explicit resume is the reactivation boundary for Saved.
- Done and legacy Archive share one terminal presentation and resume policy.
- Lifecycle migration is live catalogue state and must be handled deliberately when installing a
  build against an existing catalogue.
