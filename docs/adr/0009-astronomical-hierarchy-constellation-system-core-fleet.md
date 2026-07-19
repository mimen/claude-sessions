# The orchestration hierarchy is astronomical: constellation > system > (core | fleet)

Milad's "resume a constellation" (2026-07-07) collided with ccs's existing meaning
of constellation (a connected component of the parent->child graph, auto-named after
the root's skill — a derived VIEW, not something you create). He also wanted the
whole operation (workers + the sessions that run them) grouped as its own level,
with room for OTHER things happening on the machine outside it. Verified in ccs:
"system"/"cluster"/"galaxy"/"star" are all free (only test fixtures + a UI margin).

Decision: a three-level, all-astronomical hierarchy.
- **Constellation** — ccs's existing machine-wide graph grouping, UNCHANGED. Can
  contain several systems plus unrelated loose stars.
- **System** (star system) — NEW first-class level (chosen over a tag): the
  operation "pr-watch" as one resumable unit. `ccs resume <system>` brings it up.
- **Core** (the star) — the support that RUNS the system and is its gravitational
  center: control plane, concierge, eval, designer. Never marked completed.
- **Fleet** (the planets) — the per-PR workers orbiting the core; one per PR. A
  planet is pruned from resume by lifecycle (completed/archived), never the core.

So: a constellation contains systems; the pr-watch system is a core with a fleet
orbiting it. "Fleet" (naval) is kept for the workers deliberately — it is Milad's
word and reads fine as the planets; everything else is astronomical.

This is level B (a real primitive), NOT a tag. Consequence / ccs build: "system"
must become a first-class grouping in ccs — today ccs has only the graph-derived
constellation and flat tags, nothing named in between. Adds a `system` field (or a
named-group table) to the catalogue, a resolver, and teaches `ccs resume` + the TUI
groups-view about the new level. More work than a tag, but it makes "system" a
real, selectable, resumable thing.

Supersedes the tag-based framing of ADR-0006: fleet MEMBERSHIP is now the `system`
grouping, not a `pr-watch-fleet` tag. ADR-0006's substance stands — `parent` still
records only real spawn edges (eval/designer are core, not parented under the
orchestrator) — but the fleet/operation is defined by the system primitive, and
core-vs-fleet is a role within the system.

## Role assignment rule (correction, 2026-07-08)
A session's `skill` role is NOT inferred from title keywords. The one-time history
backfill wrongly tagged 4 sessions `review-agent` because their titles contained
"assess"/"re-review" (#12089/#12078/#12080/#12094) — but all four were pr-agents
doing an assess/self-review TASK on MILAD'S OWN PR, in his own worktree. Corrected
all to pr-agent. The real distinction:
- **pr-agent** — authors/owns one of MILAD'S PRs (build, fix, assess, re-review,
  browser-validate — assessing is a task a pr-agent does, not a separate role).
- **review-agent** — reviews SOMEONE ELSE'S PR (the `review` work-type; DRAFT-only,
  never edits the branch).
So role = whose PR it is + whether it edits, NOT a title keyword. Going forward the
control plane sets `skill` at spawn from the dispatch work-type (author vs review),
which knows the truth; no heuristic. catalogue_sync (the live producer) does not set
skill, so it can't re-misclassify.
