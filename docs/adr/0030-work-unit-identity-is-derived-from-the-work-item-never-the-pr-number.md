# The work-unit in an identity key is derived from the WORK ITEM, never the PR number

Closes the one live contradiction a design review found between ADR-0013 and
ADR-0026, and independently flagged by a Cursor/GPT review as "the biggest hole —
write this before implementation." Decided with Milad 2026-07-09.

## The contradiction

ADR-0013 decided pr-watch identity is STRUCTURED (`gus_work` + `pr_repo`/`pr_number`)
and that the glued string `heroku_dashboard-12113` is "flimsy" — a stringly-typed
union that means different things pre-PR vs post-PR, the exact thing whose re-keying
migration ADR-0013 exists to kill. Its core win: **pre-PR → PR is a FACT UPDATE, not a
re-key** — `pr_number` goes null→set, nothing renames.

But ADR-0026 made the identity key `[cluster]·role·[work-unit]` and its examples used
`pr-watch·pr-agent·heroku_dashboard-12113` — the glued PR string. Since the inbox and
all identity-scoped state key on the work-unit (ADR-0023/0025/0026), that reintroduces
the bug: a pre-PR worker keyed on its W-number and the same worker post-PR keyed on
`repo-prnumber` have DIFFERENT inbox paths. Opening the PR would silently split the
mailbox and orphan everything the worker was told while pre-PR.

## Decision — the work-unit is the WORK ITEM (W-number), always

For pr-watch, the work-unit component of the identity key is the **work item
(GUS W-number)**, with an optional epic-shortname prefix. The PR number is NEVER part
of the key.

- **General form:** `cluster · role · [epic-short/] work-item`.
  - e.g. `pr-watch · pr-agent · metered/W-12345678`
  - inbox: `inbox/pr-watch/pr-agent/metered/W-12345678/`
- **A WI is always present.** Every fleet worker is born against a work item. If a piece
  of work has no ticket yet, a placeholder ticket is created BEFORE the worker is
  spawned — so there is no "orphan PR, no WI" case for the key to handle. This is a
  deliberate constraint (Milad 2026-07-09): uniform keys beat modeling the orphan case.
- **Epic is an optional prefix.** If the WI belongs to an epic, its short name prefixes
  the work-unit for legibility + grouping. If there's no epic, the work-unit is just the
  WI (`pr-watch · pr-agent · W-12345678`). The epic prefix is display/grouping sugar; see
  the re-parenting note below.
- **The PR is an ATTRIBUTE, not the key.** `pr_repo`/`pr_number` remain structured
  catalogue columns (ADR-0013) that go null→set when the PR opens. They drive the tab,
  the statusline PR link, and PR-sense — but they never appear in the identity key or any
  state path.

## Why this closes the hole

The WI is stable for the entire lifecycle (ADR-0013: "set when work starts; stable for
the whole lifecycle; NEVER changes"). Because the key derives from the WI and never from
`pr_number`, the pre-PR → PR transition changes NO path: the inbox, result, and judgment
all stay put while `pr_number` fills in as a fact. Continuity across that boundary — the
exact thing ADR-0013 protects — is now preserved by construction in the ADR-0026 key
model, instead of being contradicted by it.

## Edge cases, decided

- **Epic re-parenting.** The epic prefix is derived, not identity. If a WI is moved to a
  different epic, the *display* prefix changes but the durable key is anchored on the WI,
  so state does NOT move. Implementation: resolve state paths by WI; treat the epic prefix
  as a render-time decoration OR store it as a stable-at-birth prefix that display can
  update without moving state. Either way, re-parenting is never a re-key. (Pick the
  concrete mechanism at build; the invariant is "WI anchors the state, epic never does.")
- **Spike with no PR.** WI set, `pr_number` null the whole time — still a full fleet
  member (ADR-0013). Its key is just `cluster·role·[epic/]WI`; nothing special.
- **WI reuse / a completed WI reopened.** Completed state is retained, not thrown away
  (ADR-00xx completed-not-archived). A reopened WI resolves to the SAME key and therefore
  the same (retained) mailbox/state — acceptable and arguably correct; WI reuse is rare
  (Milad 2026-07-09).

## Consequences

- ADR-0026's examples are corrected: fleet work-unit is `[epic/]WI`, not `repo-prnumber`.
  ADR-0026's "session id is the fallback for unassigned sessions" is unchanged.
- ADR-0013 is fully honored: structured identity, PR as a fact, no re-keying migration.
  `migrate_keys.py`'s only remaining job stays "populate `pr_number` when the PR opens,"
  never re-key.
- Build: the WI-always constraint means the spawn path must ensure a WI exists (create a
  placeholder ticket) before `ccs new-session` for a fleet worker. State-path resolution
  is a pure function of `(cluster, role, epic-short?, gus_work)`.
- Generalizes cleanly: another cluster (event-watch) picks its own stable work-unit
  (an event slug), same rule — the key derives from the durable work-unit fact, never
  from a downstream artifact like a PR that appears mid-lifecycle.
