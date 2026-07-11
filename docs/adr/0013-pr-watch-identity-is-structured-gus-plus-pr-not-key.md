# pr-watch identity is structured (gus_work + pr_repo/pr_number), not the opaque `key`

Refines ADR-0011. That ADR renamed ccs `event` -> a neutral opaque `key` and said
each system fills it with its own storage key; for pr-watch that was
`heroku_dashboard-12113`. Milad flagged (2026-07-08) that this is flimsy: for
pr-watch the `key` is just pr_repo + pr_number glued into a string, and pre-PR it
would hold the GUS W-number instead — a stringly-typed union that MEANS DIFFERENT
THINGS at different times, which is the only reason a "change it over" migration
(migrate_keys.py) has to exist. Forcing two distinct structured facts into one
opaque slot created the fragility.

Decision: pr-watch identity is STRUCTURED, and `key` is not pr-watch's identity.
- `gus_work` (W-number) — NEW catalogue column. Set when work starts; stable for
  the whole lifecycle; NEVER changes. Null for orphan PRs (no ticket).
- `pr_repo` + `pr_number` — already exist (slice 5 PR-sense). Null pre-PR;
  POPULATED when the PR opens.
- Pre-PR -> PR is NOT a re-keying — it is `pr_number` going from null to set (a
  fact update). Nothing renames, nothing migrates. Pre-PR fleet member = gus_work
  set + pr_number null; it is part of the fleet the whole time (Milad: pre-PR work
  "still wants to be part of the fleet" and must "update once the PR is created").
- Matching a catalogue session to pr-watch state joins on the structured columns
  (pr_repo+pr_number for a PR; gus_work for pre-PR), not on an opaque key.

`key` (the renamed `event`) STAYS as the generic optional single-slug identity for
systems whose unit has no natural structure (event-watch: an event slug like
"kiki-factory" — genuinely one opaque string). It is redundant ONLY for pr-watch,
not in general, so it is not removed from ccs; pr-watch just does not use it for
identity. This preserves ADR-0011's real win (de-leaking event-watch's `event`
name) while dropping its overload (one key = identity + storage + reference).

Neither gus_work nor pr is universally present (a spike has GUS no PR; an orphan
has PR no GUS), which is itself the proof a single always-present opaque key can't
model this cleanly — structured columns handle the partial cases; a lone `key`
can't. The per-session-stable primary key remains ccs's session_id; gus_work/pr are
the WORK-UNIT attributes that group multiple sessions onto one unit.

Consequence / build: add a `gus_work` column to the ccs catalogue (migration v8);
backfill historical sessions with gus_work (from PR-title W-numbers) + pr_repo/
pr_number (from the resolved PR map) instead of `key`; extend migrate_keys' role to
"populate pr_number when the PR opens" rather than re-key. pr-watch's own
state-file naming (still pr-<repo>_<num>) is a separate internal concern (a follow
-on could key it on the stable gus_work to kill the filesystem rename too).

## Amendment (2026-07-08, confirmed with Milad)
Two clarifications after building this:
1. **ccs supplies core primitives; the FLEET ORCHESTRATOR owns membership/meaning.**
   ccs stores `gus_work` (and `system`, `pr_*`, `skill`, lifecycle) as generic,
   opaque-to-ccs fields. ccs never decides what "in pr-watch" means or interprets a
   W-number — the orchestrator does. This is the line: ccs = storage + generic
   grouping mechanism; orchestrator = workflow policy + membership. (Milad: "supply
   core primitives/metadata on ccs and let the orchestrator for the fleet be the one
   to handle how it uses them to determine membership.")
2. **`gus_work` IS a first-class column, and that's good** — not a leak. It's a
   structured, stable, extra identification AXIS (like the existing `project`
   column), better than the opaque `key` for pr-watch because it never has to change
   over as work goes pre-PR -> PR. (Milad: "gus ticket is a great column ... key
   seems flimsy here.") Membership logic still lives in the orchestrator; ccs just
   holds the id. A brief detour considered modeling the W-number as a tag instead —
   rejected: a first-class column is a cleaner, queryable identity axis and matches
   how `project` already works.

Shipped (ccs @ feat/catalogue-system-and-pr-sense): migration v8 adds `gus_work` +
setGusWork + sessionsForGusWork. pre-PR = gus_work set, pr_number null; PR-open just
populates pr_number (no rename). Historical backfill: 31 sessions / 24 PRs / 22 GUS
tickets stamped with structured identity on the live catalogue; interim `key` values
cleared (key remains only for systems like event-watch whose unit is a bare slug).
