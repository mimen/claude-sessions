# ADR-0089: Identity as a first-class entity

**Status:** accepted (2026-07-14)
**Scope:** ccs platform + all clusters that consume it (pr-watch first)
**Companion scoping doc:** `~/Desktop/ccs-identity-refactor-2026-07-14.html` (transient — this ADR is the durable record)

## Context

Since ADR-0057 the catalogue has carried `work_unit_id` as a column with the intent of promoting "the durable job a session works on" from a derived string into a real entity. That intent stopped halfway. Today:

- `catalogue.work_unit_id` is a column with no `work_units` table backing it — a FK-shaped string pointing at nothing.
- `catalogue.key` is a **cache of a derived value**, recomputed by `deriveKey()` on every mutation that touches role/cluster/pr_*/gus_work/work_unit_id. It carries "identity" as a fingerprint of session-scoped columns, not as a reference to an entity.
- Twin sessions for the same PR are two rows that happen to share identity-relevant columns. There is nothing that says "these two sessions belong to the same identity" except the derived fingerprint matching.

This isn't a bug — it's just where the model landed after eight ADRs of accretion. But it forces several categories of complexity that the codebase has to keep paying for:

1. **Every sensor script has to bridge session-scoped columns to PR-scoped facts.** `catalogue_sync.py`, `compose_board.py`, `gate_eval.py`, `retire_sweep.py`, `worker_activity.py`, `membership.py` all extract prRepo+prNumber from a row and reconstitute a flat key to look up state elsewhere. Three-plus parallel keying schemes converge on the same entity.
2. **Twin de-duplication logic lives in the composer, not the model.** `compose_board.py` explicitly reconciles multiple session rows down to one identity row per output. Every board consumer inherits the mental model "board is keyed on identity, catalogue is keyed on sessions" without a name for what identity IS.
3. **`ccs stage` / `ccs status` / `ccs mark` write to sessions but conceptually live on identities.** A worker respawn re-senses stage from scratch and briefly shows stale values because there's no per-identity storage that survives across sessions.
4. **State is scattered across the filesystem.** Inboxes are files under `~/.ccs/identities/<cluster>/<role>/<work-unit>/inbox/`, addressed by a tuple; dispositions are one JSON file per cluster; the concierge's pending queue is another file. Same conceptual keying (per-identity), three storage mechanisms.
5. **Adding a new cluster requires touching ccs.** Because cluster vocabulary (pr_repo, pr_number, gus_work, grouping_id) is baked into the catalogue schema, a hypothetical issue-watch or sprint-tracker cluster has no clean way to declare its own attributes without ccs schema changes.

The one-time cost of the refactor is real. The **ongoing** cost of the current model is what motivates it.

## Decision

Adopt a **three-tier data model**:

```
Session      ────►   Identity     ────►   Grouping
(this claude         (the durable         (the WHAT-IT'S-
 conversation)        work-item)           PART-OF, e.g. epic)
```

Sessions are per-run. Identities are durable per work-item. Groupings are cross-identity organizational entities.

### Two role kinds

Every role declares its `kind` in `role.toml`:

- **`core`** — exactly one identity per cluster, tuple `(cluster, role)` IS the identity. Examples: concierge, control, designer, scout, eval.
- **`fleet`** — N identities per cluster, one per work item. Examples: pr-agent, review-agent.

Only fleet roles need a per-role attributes table. Core role identity is fully determined by the tuple + universal columns.

### Storage

All durable state lives in `~/.ccs/cache/catalogue.db`:

**Universal tables:**
- `sessions` — thin, per-run: session_id PK, identity_key FK, resume_id, custom_title, parent_session_id, meta, updated_at
- `identities` — durable per work item: identity_key PK, cluster, role, kind, grouping_id FK, stage, status_line, completed, archived, parked_task_id, meta
- `groupings` — durable per grouping: grouping_id PK, cluster, role, label, url, short_name, notes JSON, context TEXT, closed, meta
- `inboxes` — messages keyed by identity_key
- `identity_state` — key/value scratch per identity
- `dispositions` — decision ledger

**Per-fleet-role tables** — materialized at ccs boot from `identity-schema.toml` in the role's config folder. For pr-watch: `identity_pr_agent` (pr_repo, pr_number, pr_state, pr_head_sha, pr_branch, gus_work, gus_work_sf_id).

**Opaque per-identity blobs** — `~/.ccs/clusters/<c>/identities/<role>/<key>/` scratch dir for worker-authored files (judgment.json, screenshots/, whatever). Path derived from identity_key, contents ccs never inspects.

### Identity key format

Structured, human-readable, stable:

```
<cluster>:<role>:<work_ref>          # fleet
<cluster>:<role>                     # core
```

Examples: `pr-watch:pr-agent:owner/repo#12345`, `pr-watch:concierge`. Opaque to ccs; structured only for human legibility.

### Stage lives on identity, engine owns computation

`stage` moves to `identities.stage` as an **opaque string**. Ccs stores whatever value it's given; it does not validate against a vocabulary, does not enforce ordering. The cluster's engine (e.g. `catalogue_sync.py`) owns the vocabulary, computes stage from its sensor inputs every tick, applies monotonic/other ordering rules, and writes through `ccs identity set --stage=<value>`. A rogue worker write is a data race the next sensor tick corrects, not a schema violation.

Same treatment for anything else the engine computes: ccs stores state, engines compute state, no shared vocabulary crosses the layer boundary.

### Groupings are real entities

The `groupings` table replaces `~/.ccs/clusters/<c>/cluster/groupings.json`. Groupings carry display metadata (label, url, short_name), accumulating project notes, an optional long-form authored `context`, and a `closed` flag. `identities.grouping_id` is a real FK. Cross-identity queries ("all pr-agents in the Team Tokens epic") become one join.

### CLI reorg

Ships with the refactor. Six nouns:

- `ccs identity` — mint / set / unset / list / read / path / complete / archive / resume / bump
- `ccs session` — set / new / title / list / read / bump
- `ccs cluster` — read / list / init / resume / board / catch-up / decide / reap-duplicates / sync-roles
- `ccs grouping` — read / list / upsert / set / unset / note-add / close
- `ccs inbox` — send / pending / drain / bump
- `ccs state` — narrowed to `get`-only debug convenience for reading sensor JSON files (or deleted entirely — decided during implementation)

Every mutation uses `--field=value` flags. Reads are the bare noun.

No aliases. The following commands **are deleted**, callers migrate in the same release:

`meta`, `meta-set`, `rename`, `mark`, `tag`, `key`, `parent`, `project`, `epic`, `set-cluster`, `system`, `role`, `gus-work`, `status`, `name`, `stage`, `session-fields`, `new-session`, `new`, `bump-session`, `resume-session`, `resume-cluster`, `board`, `catch-up`, `decide`, `suppress`, `identity resolve`, `register-session`, `roles`, `sync-roles`, `hooks explain|lint`, `backfill-work-units`, `reap-duplicates`.

## Consequences

### Wins

- **One storage backend.** SQLite for all durable state; sensor outputs stay as regenerable JSON files.
- **Real joins.** `SELECT * FROM identities LEFT JOIN identity_pr_agent USING (identity_key) WHERE grouping_id = ?` powers everything.
- **Schema-in-role.** Adding a new fleet role type = drop a folder with role.toml + identity-schema.toml. Ccs materializes storage automatically.
- **CLI collapse.** `ccs identity set <key> --pr_number=… --stage=… --grouping=…` replaces ~10 per-session command names.
- **Stage correctness across respawns.** Living on identity, not session, means twins share truth.
- **Roll-ups first-class.** "How many identities per grouping" is one SQL query, not an ad-hoc file scan.
- **Ongoing cost of pr-watch cluster drops ~26%.** ~5,400 → ~4,000 lines across skills, hooks, sense scripts (approximate; captured in the scoping doc's line-count table).

### Costs

- **One-time engineering effort of ~35h.** In line with the earlier decoupling research's 28-40h estimate. Bigger than any single phase of the 2026-07-14 hardening arc; smaller than the arc as a whole.
- **Full migration in one release.** No aliases, no gradual rollout. Ccs + pr-watch merge together on a coordinated commit. Rollback via a v31 backup file (`catalogue.db.v31.bak`) that the migration writes before touching anything.
- **Losing `cat` access to inboxes/state.** Debugging becomes `ccs inbox pending <key>` instead of `ls`.
- **Two mutation surfaces per fleet identity** — `identities` and `identity_<role>`. Every fleet mutation is a small transaction.

### What doesn't change

- `ccs catalogue export` keeps its output envelope shape. It joins identities × per-role tables in-code and emits flat JSON. Engine consumers don't need to know the underlying layout changed.
- Sensor output JSON files (board.json, gate.json, poll.json, etc.) stay as files, still written by the engine. They're per-tick regenerable; putting them in the DB buys nothing.
- Cluster configuration under `~/.ccs-config/clusters/<c>/`.

## Alternatives considered

**Files-based identity storage** (one TOML per identity under `~/.ccs/clusters/<c>/identities/<role>/<key>.toml`). Rejected: files-as-database is a database in denial. Rename resilience is a wash; browsability of raw TOML rows isn't actually useful; atomicity via write-and-rename recreates SQL's job without SQL's guarantees.

**Universal `identity_attrs` EAV table** (or fat JSON on identities) instead of per-role tables. Rejected: loses column indexes, loses type safety, and the per-role-tables machinery is small enough (~150 LOC + tests) to be worth the query power.

**Ship a deprecation window with aliases.** Rejected per Milad's explicit rule: aliases are complexity debt disguised as compatibility. All-at-once is riskier for a day, safer for a year.

**Defer until a second cluster type forces the design.** The earlier decoupling research (subagent aa0b6464) recommended exactly this. Rejected: the ongoing cost of the current model is already high in pr-watch alone; a second cluster would benefit but isn't the forcing function. The forcing function is that every future pr-watch change has to navigate the session-vs-identity confusion.

## Implementation

13-step sequence captured in the scoping doc; each step is independently verifiable, the sequence chosen so later steps can't proceed without earlier ones landing. Migration is transactional with a rollback backup. Hook/skill prose changes are guarded by a post-refactor lint script that greps for deleted command names.

## References

- [[adr-0057-work-unit-entity]] — the partial move that this ADR completes.
- [[adr-0064-role-declared-stage-schema]] — becomes moot; ccs no longer validates stage.
- [[adr-0068-mutation-boundary]] — extends to identities + per-role tables.
- [[adr-0078-catalogue-export-boundary]] — the export envelope stays; the layout underneath changes.
- [[adr-0080-role-identity-cluster-plus-role]] — codified here as `kind = "core"` in role.toml.
- [[adr-0087-epic-level-hooks-runtime-state]] — the same "cluster vocabulary out of the platform" principle.
