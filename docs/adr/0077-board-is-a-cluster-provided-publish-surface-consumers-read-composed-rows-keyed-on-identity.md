# Board is a cluster-provided publish surface; consumers read composed rows keyed on identity

Decided with Milad 2026-07-13. Grew out of the pr-watch phase-first design (see `~/.ccs-config/clusters/pr-watch/docs/learnings.md`, 2026-07-13 entry). Codifies the tool-vs-cluster split so ccs stays the machinery — clusters own the business rules.

## The gap

Today ccs consumers that render or route based on session state (cmux tab pill, TUI stage column, hooks) read directly from `catalogue.stage` (or other catalogue columns). Two problems fell out:

- **Catalogue's `stage` is the state machine's raw opinion.** It doesn't reflect the RESOLVED view — GitHub facts overriding a stale internal latch, alerts fired by sensors, who's currently waiting on whom. pr-watch's `catalogue_sync.py` writes a truthful raw stage but a phase-first cluster needs to layer external facts on top, and no surface today displays the composed answer.
- **Rows are keyed on sessionId.** Sessions churn (twins, respawns, dead-pid phantoms cleaned up by `ccs reap-duplicates`) but responsibilities don't. Two twins for the same PR could render different pills because each session's catalogue row updates independently — a divergence bug we've hit.

Additionally, if we bake pr-watch's phase vocabulary (`building`/`milad-review`/`in-review`/`approved`/`merged`) or its alert names (`ci-red`, `feedback-pending`) into ccs itself, we couple the tool to one cluster's business. A future cluster (bugfix triage, incident response, anything not-PR-shaped) would find ccs unhelpful or need to shim its concepts into PR-shaped words.

## Decision

**Every cluster provides a `board` composer. The tool provides the schema, the publish surface, single-row operations, and consumer wiring.** Rows are keyed on **identity** (`cluster:role:work-unit`), not sessionId. Consumers that need session-specific data resolve session→identity first.

### Tool contract (`ccs`, cluster-agnostic)

- **A well-known board.json schema** with fixed render primitives plus a free `data` blob:

  ```json
  {
    "identity": "pr-watch:pr-agent:heroku/dashboard#12123",
    "workUnit": { "kind": "pr", "repo": "heroku/dashboard", "number": 12123, "gusWork": "W-..." },
    "sessions": [
      { "sessionId": "14731361-...", "isPrimary": true,  "lastActivity": "2026-07-13T21:00Z" },
      { "sessionId": "62becec7-...", "isPrimary": false, "lastActivity": "2026-07-13T20:12Z" }
    ],
    "pills": [
      { "key": "ccs_lifecycle", "label": "in review", "icon": "person.2", "color": "#bf5af2", "priority": 50 }
    ],
    "description": "waiting on @heroku/front-end + worker (ci-red)",
    "alerts": [
      { "name": "ci-red", "severity": "hard", "reason": "unit tests failed", "owner": "control", "sinceTick": 3 }
    ],
    "awaitingFrom": ["reviewers", "worker"],
    "lastComposed": "2026-07-13T21:15Z",
    "data": { /* cluster-arbitrary; ccs never renders it, but skills + composer share via it */ }
  }
  ```

  Fixed primitives are what ccs KNOWS HOW TO RENDER: `pills[]`, `description`, `alerts[]`, `awaitingFrom[]`. Free `data` is where clusters stuff their business-specific fields (pr-watch puts `stage`, `github`, per-alert timestamps, etc. here — for reference, they're inputs to the composer's own future ticks and to skill prompts, not tool concern).

- **`cluster.toml` names the board composer** the same way `sense` is named today:

  ```toml
  # cluster.toml
  board = "engine/scripts/compose_board.py"
  ```

  ccs invokes it with a well-defined argv contract (whole-board OR single-row via `--identity <key>`) and expects `board.json` written to the well-known state path.

- **`ccs board <c>` command family:**
  - `ccs board <c> [--json | --text]` — whole board.
  - `ccs board <c> --identity <key>` — single-row read.
  - `ccs board <c> --recompose <key>` — synchronous single-row recompose. Every op has a single-row form; small ops compose into big ops, the reverse doesn't work.
  - `ccs board <c> --stage <s>` — filter helper (`stage` value comes from the `pills[]` `label` field or a first-class cluster-facet field the composer emits; TBD in the pr-watch phase-first followup).

- **Session→identity resolver + light indexer.** ccs already knows the (session, identity) mapping via `identityKeyOf(row)`. The indexer wraps board.json for O(1) lookups both ways; invalidated by any composer write.

- **Cmux paint + ccs TUI read board.json.** `render-tab.ts::renderTab` computes the pill from `pills[]` (already keyed the right way), description from `description`, and can render additional pills/badges from `alerts[]` per severity. TUI's stage column reads the `pills[]` label. No consumer reads `catalogue.stage` for rendering; the DB column is deleted.

- **Freshness contract.** Every board op that WRITES state a consumer will render (`ccs meta … milad_review approved`, `/prwatch:approve`, `ccs sync-tabs <sid>`) must trigger a synchronous single-row recompose before returning. Otherwise the sidebar paints stale immediately after a state-changing write — the exact bug we're trying to fix.

- **Fallback.** If a cluster provides no composer, ccs ships a **default composer** that copies catalogue rows through as trivial pills (basically the current behavior, wrapped in board.json). No cluster is left without a board.

### Cluster contract (its composer, cluster-specific)

- **Read the catalogue + cluster-owned sensors** (pr-watch has `poll.py`, `review_sense.py`, `github_review_state.py` after the phase-first work lands).
- **Apply business rules** — pr-watch overrides stage with GitHub facts, derives an alerts multiset, computes awaitingFrom.
- **Emit board.json in the tool's schema.** Populate the primitives; stuff cluster-specific extras into `data`.
- **Support single-row invocation** (`compose_board.py --identity <key>`) for the synchronous recompose path.
- **Own its alert vocabulary.** Alerts are strings the composer emits; the tool renders them but doesn't know what any specific alert means. Concierge/control read the vocabulary from cluster-owned skills.

### Row key: identity, not sessionId

Sessions are replaceable; responsibilities are not. Board rows key on identity so:

- Twin sessions share ONE row. Both sidebars paint identically because they resolve to the same row.
- A row can exist without a session (ticketed-no-PR: identity known, no session spawned yet).
- Session respawns don't cause row churn.
- Every board op accepts `--identity <key>`. Session-scoped consumers (cmux paint) do a session→identity resolve then read.

### Deleting `catalogue.stage` (pr-watch's move, sanctioned here)

pr-watch removes `stage` from the catalogue schema. Every read moves to board.json. The tool's TUI stage column is populated from board.json's `pills[]` `label`, not from a DB read. This ADR authorizes the deletion at the tool level: the DB column had no other legitimate consumer.

## Non-goals

- **The tool defines NO alerts.** Even universal-feeling ones like `stale-sensor` are the cluster's to emit or not — the tool renders whatever the composer publishes.
- **The tool defines NO phase vocabulary.** No "building" or "in-review" strings anywhere in ccs code. The `pills[]` label is opaque to the tool.
- **The tool does not know what "GitHub" is.** GitHub facts are pr-watch's problem; a different cluster might have "Jira facts" or "Slack facts" or none at all.

## Migration

Ordered so each step is independently reversible:

1. **Tool ships the schema + default composer.** Every cluster gets a board.json for free (default composer just wraps catalogue rows). Old direct `catalogue.stage` reads keep working; no consumer switches yet.
2. **Tool ships `ccs board <c> --recompose <key>` + `--identity <key>` + the light indexer.** Still nobody consumes board for rendering.
3. **`render-tab.ts::computePhasePill` switches to reading `pills[]` from board.json** via session→identity resolve, with fallback to `catalogue.stage` when board is missing/stale. Ship alone. Nothing else changes yet.
4. **Cmux sidebar renders `alerts[]` as additional pills** and `description` from the composed row. UNLOCK: workers show `in review · ci-red` badges.
5. **ccs TUI switches to reading `pills[]` label** for the stage column. Same fallback rule.
6. **Skills stop reading `catalogue.stage` directly.** SKILL.md prompts read the board.
7. **`catalogue.stage` column deleted** (pr-watch's schema migration, this ADR authorizes it at the tool level).

Each step's rollback is well-defined: reverse the read source or leave both in place while auditing.

## Consequences

- **One publish surface, many consumers.** Adding a new consumer (Slack digest, web dashboard) is `read board.json`, done. No coupling to cluster-specific catalogue columns.
- **Twins can't diverge.** Both twins for an identity read the same row, so their sidebars show the same pill.
- **Rows can exist without sessions.** Ticketed-no-PR items get first-class board representation for the first time.
- **The tool becomes lighter over time.** Every cluster-specific thing that had leaked into ccs code (catalogue.stage, cluster-specific pill vocabulary, GitHub-shaped fields) moves out to the cluster composer.
- **Adding a cluster requires a composer** (or accepts the default). Small cost; better than the alternative of ccs learning every cluster's shape.
