# ccs glossary — the shared vocabulary

One canonical definition per concept, grounded in the actual code (file:line). This is the shared
language: [SYSTEM-UNITS.md](SYSTEM-UNITS.md) defines every unit using ONLY these terms + earlier units.
Where a concept has more than one name in the code, the canonical term is defined and the **alias** is
listed as naming debt to reconcile.

Written 2026-07-11 from a ground-truth extraction of `src/`. Convention: **bold** = a glossary term used
inside another definition (so you can always trace the vocabulary).

---

## Core identity

- **session** — one Claude Code conversation: a transcript file plus its ccs metadata. Identified by a
  **sessionId**. A session is a *vessel* — it can be closed and resumed; the **identity** it carries
  outlives it. (`src/index`, `src/catalogue/db.ts`)
- **sessionId** — the UUID that names a **session** (the transcript filename, the primary key everywhere).
  (`db.ts:15`)
- **resumeId** — the UUID passed to `claude --resume`. For a freshly minted **session** it equals the
  **sessionId** (forward reference); for older indexed sessions it can differ. **Liveness** and resume
  check both. (`db.ts:16`, `resume-session.ts:31`)
- **responsibility** — the durable AGENT-IDENTITY KEY: the tuple `{cluster?, role, epic?, workUnit?}`. It is
  what a session is *responsible for*, and it survives resume. NOT the same as **identity** (this is the
  key; identity is the context it indexes). (`inbox/identity-path.ts:22`)
- **identity** — the runtime context a **responsibility** indexes: its **inbox** and **state**, under
  `~/.ccs`. "This session's identity" = the durable thing; the session is just its current **embodiment**.
  (`resolve-levels.ts`, `identity-path.ts:41`)
- **embodiment** — a **session** actively running in a **surface**/**workspace** right now. **Liveness** is
  the presence of an embodiment. One identity has at most one live embodiment (see **one-embodiment rule**).
  (`catalogue/lineage.ts`)
- **lineage** / **predecessors** — earlier **embodiments** of the same **identity** (matched by
  **identity-key**), oldest→newest, so a fresh session can review prior attempts. (`lineage.ts:44`)
- **identity-key** — the string form of a **responsibility** used to match **lineage**: `rowWorkUnit(row)`
  (a **work-unit**) else `role:<role>`. (`lineage.ts:19`)

## Work grouping (the axes a session is filed under)

- **work-unit** — the specific deliverable a **session** owns. **A first-class entity with a stable,
  ccs-minted id** (ADR-0057), created when work starts. A PR, GUS item, cwd/branch, and title attach to it
  as **attributes** — they are not its identity. The unit of the **one-embodiment rule** and the key for
  **lineage**. A **session** references it by FK (`workUnitId`), like it references a **grouping**.
  - Two separate sessions recognize they're the same work by resolving to the same **work-unit id**
    (find-or-create by anchor attribute, e.g. "which work-unit has prNumber=123?"), NOT by re-deriving a
    string. A worker started with no PR/GUS yet simply gets a work-unit with an id and no attributes.
  - **Historical / being retired:** the work-unit used to BE a derived string — `pr:repo#number` |
    `gus:W-id` | `sid:sessionId` — computed **6 times** across the code, 2 copies drifted to a non-joining
    `repo-number` form (the P0 U4/S2 finding). ADR-0057 replaces the string with the entity; `pr:repo#123`
    survives at most as a display label. (`spawn-contract.ts:23` today; entity per ADR-0057)
- **cluster** — a named set of sessions that run one operation together (e.g. `pr-watch`). The **fleet**
  plus the **core** roles. Canonical everywhere (ADR-0059); the DB column `system` is being renamed to
  `cluster`. (`cluster-map.ts`, `db.ts:42`)
- **grouping** — a mid-level work grouping bigger than a **work-unit**. The platform concept is **grouping**;
  a grouping has a **type**, and pr-watch uses an **epic**-type grouping (ADR-0059). A **session** carries an
  `epicId` FK (a typed grouping reference); the display metadata (label/url/shortName/notes) lives in
  **cluster state**, not the **catalogue**. (`state/groupings.ts:18`)
- **project** — a loose user label grouping otherwise-unrelated sessions (an initiative name). Distinct
  from **cluster** (operation) and **grouping** (work). (`db.ts` project column)
- **key** — an opaque identity-grouping slug. Canonical (ADR-0059); the deprecated **event** column/command
  is being removed. (`db.ts`, ADR-0026/0030)
- **tag** — an ad-hoc many-to-many entity label on a session (`session_tags`). (`db.ts:668`)
- **parent** / **constellation** — a session's optional `parentSessionId` edge; the tree of edges is the
  constellation. (`db.ts` parent, `lineage.ts`)

## Role & kind

- **role** — a session's first-class identity axis: what it *is* (`control`, `concierge`, `slack-scout`,
  `eval`, `pr-agent`, `designer`). Drives which **skills**/**commands**/**hooks** materialize. Canonical
  (ADR-0015); the deprecated **skill** column is being removed (ADR-0059). (`db.ts:29-34`)
- **kind** — a **role**'s classification: **`loop`** (re-arms on resume via **resume_command**, comes back
  running) or **`session`** (bare; rehydrates from **inbox**/**state**). (`db.ts:11`)
- **core** vs **fleet** — **core** = the singleton infrastructure roles (control/concierge/slack-scout/
  eval/designer); **fleet** = the per-**work-unit** workers (pr-agents). (`cluster-map.ts`)
- **role-def** — a **role**'s DEFINITION, read from files (`role.toml` + directory structure), never a DB
  cache: `{role, cluster, kind, homeDir, resumeCommand, skills[], commands[], hooks[]}`. (`role-files.ts`,
  ADR-0050)
- **role.toml** — the TOML manifest in a role directory holding the non-derivable bits (`kind`,
  `resume_command`); everything else is derived from the directory. (`role-files.ts:34`)
- **resume_command** — the command a **loop** re-fires on resume so it comes back running
  (e.g. `/loop 15m /pr-watch-control`). (`db.ts:35`)

## Stores (where state lives)

- **catalogue** — the durable, user/agent-authored metadata store (SQLite). One **row** per **session**
  (**CatalogueRow**). Survives **index** rebuilds. (`catalogue/db.ts`)
- **CatalogueRow** — the metadata record for a session: identity axes (role, cluster/system, key, epicId,
  gusWork), PR facts, **stage**/**activity**, **statusLine**, **miladReview**, **buildComplete**, lifecycle
  bits. (`db.ts:15-79`)
- **index** — the ephemeral cache of parsed transcripts (SQLite). Dropped and rebuilt on schema bump; pure
  cache, reconstructable from the transcript files. One **SessionRow** per transcript. (`src/index`)
- **SessionRow** — the parsed-transcript record: cwd, project, timestamps, **resumeId**, cost/tokens,
  user-turns, tick cadence, resolved **title**. (`index/index.ts:8`)
- **state doc** — a durable JSON file wrapped in an envelope `{schemaVersion, updatedAt, source, data}`,
  written atomically (temp+rename), corrupt files quarantined. (`state/store.ts:29`)
- **mergeFields** — the single-writer-per-field update on a **state doc**: read, merge given fields, write
  atomically; untouched fields preserved. (`store.ts:93`, ADR-0031)
- **cluster state** — **state docs** scoped to a **cluster** (`~/.ccs/clusters/<c>/cluster/*.json`), e.g.
  **board**/**gate**/**pending**, **grouping** display metadata. (`state/cluster-state.ts`)
- **inbox** — a durable per-**identity** file mailbox. Delivery is independent of **liveness**; a
  **message** is written atomically, then **drained** move-on-drain into `processed/`. (`inbox/inbox.ts`)
- **message** — one **inbox** item `{path, sender, body}`, written with a `ccs-from:` sentinel header.
  (`inbox.ts:26`)

## cmux embodiment (the terminal substrate)

- **cmux** — the terminal multiplexer ccs runs sessions inside. External binary; the whole **bridge** is
  coupled to its version (0.64.17). (`src/cmux`)
- **surface** — one cmux pane/tab where a Claude agent runs. Identified by a **surfaceId** (stable UUID).
  One surface → one **workspace**. (`cmux/bridge.ts:59`)
- **workspace** — a cmux workspace (a tab holding panes/surfaces), identified by a **workspaceId**. Its
  **tab** is owned by its **primary surface**. (`bridge.ts`)
- **primary surface** — the tab-owning surface of a **workspace**: the earliest claude-running surface in
  tree order. Non-primary sessions skip painting the **tab**. (`bridge.ts:167`, ADR-0027)
- **tree** — the cmux JSON hierarchy (windows→workspaces→panes→surfaces) from
  `cmux tree --all --json --id-format both`. Ground truth for "what **surface** exists now". (`live.ts:31`)
- **hook store** — cmux 0.64's `~/.cmuxterm/claude-hook-sessions.json`, populated by cmux's claude shim.
  Holds `activeSessionsBySurface[surfaceId] → sessionId` (the authoritative binding) plus per-session
  detail. (`bridge.ts:147`, ADR-0054)
- **bridge** — the surface-keyed link between **sessions** and their live cmux bodies, built by
  intersecting the **hook store** bindings with the live **tree**. Answers **liveness**. (`bridge.ts:192`)
- **liveness** — whether a **session** currently has a live **surface** (is **embodied**). Computed by the
  **bridge**; exact (surface-UUID join), no title/cwd guessing. (`cmux/liveness.ts`)
- **readable** — whether the **bridge**'s inputs (the **tree** command AND the **hook store** file) were
  actually read this snapshot. If not readable, spawning operations **fail closed**. (`bridge.ts`, ADR-0054)

## Spawn / resume

- **spawn** — the birth of a NEW **session**: mint a **sessionId**, write **catalogue** metadata, then
  launch. Governed by the **spawn contract**. (`catalogue/new-session.ts`)
- **spawnCmux** — the ONE primitive that launches a `claude` invocation into a fresh detached **workspace**
  (plain command so cmux's shim registers it in the **hook store**). Returns the new **workspace** ref.
  (`resume/spawn-cmux.ts`)
- **resume** — the revival of a CLOSED **session**: check **liveness** (skip if already **embodied**), else
  `claude --resume <resumeId> [resume_command]` via **spawnCmux**. (`resume/resume-session.ts`)
- **launch dir** — the directory `claude --resume` must run from so Claude finds the transcript: the real
  dir whose **path-encoding** matches the transcript's **storage folder**. (`resume/locate.ts:71`)
- **path-encoding** / **storage folder** — Claude Code encodes a session's cwd (non-alphanumerics → `-`)
  into a folder name under `~/.claude/projects/`. That **storage folder** is authoritative; the **launch
  dir** is recovered from it. (`locate.ts`)
- **spawn contract** — the born-correct gate (ADR-0047): a worker **spawn** is refused unless it passes the
  **one-embodiment rule** and the **correct-worktree** check. **Core** roles carry no **work-unit** and pass
  through. (`spawn-contract.ts:56`)
- **one-embodiment rule** — at most one live **session** per **work-unit**. Enforced at **spawn** (contract)
  and at **resume** (**supersede-dedup**). (`spawn-contract.ts`, ADR-0032)
- **supersede-dedup** — in a **cluster** resume, if a **work-unit** already has a live **session**, older
  dead siblings are *superseded* (not resumed), so one PR never gets duplicate panes. (`resume-cluster.ts`)
- **retired** — a **session** marked **completed** or **archived**; never revived. (`db.ts:394` lifecycle)
- **selector** — a token that resolves to **sessionId**s: an id, `#pr` / `repo#pr`, `W-id`, an **grouping**
  short-name, a **role**, or a **cluster**. (`resume/selector.ts`)

## Hooks (deterministic layered config at Claude lifecycle moments)

- **hook** — a config point that fires at a Claude Code moment (SessionStart, Stop, PreToolUse…). Each
  **hook type** declares a **merge strategy**. Config is **resolved** per session, deterministically.
  (`hooks/hook-types.ts`)
- **hook type** — one of 8 registered types: **claude-md**, **start**, **stop**, **meta-update**,
  **cmux-paint**, **statusline**, **spawn-location**, **guard**. (`hook-types.ts:40`)
- **level** — one identity layer contributing hook config, ordered broad→specific: `user → cluster → role →
  epic → work-unit → identity`. Each may hold a `.ccs-hooks/<type>.{md,json}` file. (`resolve-levels.ts:20`)
- **resolution** — the pure computation from a **CatalogueRow** to the ordered list of **levels** + their
  config dirs. Absent file = contributes nothing; no search, no fallback. (`resolve-levels.ts`)
- **merge** / **merge strategy** — how a **hook type**'s per-**level** layers fold into one effective
  config: `sections` (claude-md), `set-union` (meta-update), `ordered-actions` (start/stop),
  `most-specific` (cmux-paint/statusline/spawn-location), `union-deny-wins` (guard). (`merge.ts`)
- **start action** — an action in the resolved **start** config run at SessionStart. Built-ins: **arm**,
  **drain-inbox**. (`start-actions.ts`)
- **arm** — the **start action** that re-fires a **loop**'s **resume_command** on resume so it comes back
  running. (`start-actions.ts:50`)
- **drain** / **drain-inbox** — read pending **inbox** **messages** and move them to `processed/` in one
  atomic step (idempotent). (`inbox.ts:94`, `start-actions.ts:57`)
- **meta-update** — the **hook type** declaring which **CatalogueRow** fields get *refreshed* at Stop (a
  freshness contract, not an auto-writer; external sensors write the values). (`hook-types.ts`, ADR-0044)
- **cmux-paint** — the **hook type** that owns a **role**'s **tab** appearance override (most-specific
  level wins). (`hook-types.ts`)

## Rendering & status

- **tab** — a **workspace**'s rendered cmux tab: `{title, description, color, statusPill}`, synced from the
  **CatalogueRow** by **sync-tabs** every turn. (`catalogue/render-tab.ts`, `sync-tabs.ts`)
- **pill** — the status indicator on the **tab**/**statusline** (`{label, icon, color, priority}`, one key
  so it never stacks). Rendered from **stage × activity** (or legacy **phase**). (`render-tab.ts`)
- **statusline** — the single status line ccs renders for a session (phase dot · linked PR · **grouping** ·
  W-number), staleness-aware. (`render-statusline.ts:78`)
- **sync-tabs** — the operation that reads the **catalogue** + **cluster state** and pushes **tab** render
  ops to **cmux** by **surfaceId**; never paints **retired** tabs. (`sync-tabs.ts`)

## pr-watch phase model & loop

- **stage** — a blessed first-class string column ccs stores + displays; its *values* and transitions are
  defined by the **cluster** **state machine**, not by ccs (ADR-0060). ccs treats it as monotonic/latched in
  shape. pr-watch's values: `building → milad-review → in-review → approved → merged`. (`db.ts:487`, ADR-0019)
- **meta** — a generic per-**session** map (`Record<string, unknown>`) on the **CatalogueRow** for
  role-specific scratch/state-machine storage. ccs stores/stamps/returns it but does NOT interpret it; a
  cluster adds keys without a schema migration. **miladReview** and **buildComplete** are meta keys, not
  columns (ADR-0060). (per ADR-0060)
- **state machine** — the cluster/role-defined rules over **stage**/**activity**: allowed values, legal
  transitions, when activity clears. Lives in **cluster** config; ccs provides the columns + **meta** scratch
  it needs, not the rules (ADR-0060/0061).
- **activity** — the transient state *within* a **stage**: `working` (resting baseline) / `needs-you`
  (worker self-reports stuck) / `fixing` (engine-sensed CI/conflict). Orthogonal to **stage**. (`db.ts:492`)
  - The deprecated single **phase** column (free-form) was replaced by **stage × activity** (v19) and is
    being removed entirely (ADR-0059) — renderers move fully to stage × activity. (`db.ts` phase)
- **buildComplete** — a monotonic latch: true once **stage** first reaches `milad-review`; afterward the
  build stage is sealed (ADR-0018). (`db.ts` build_complete)
- **statusLine (field)** — the human-authored freeform status on the **CatalogueRow** (`ccs status`),
  distinct from the computed **statusline** render. (`db.ts` status_line)
- **miladReview** — Milad's +1 verdict on a PR (`approved`/null); the submitter-review signal the **gate**
  reads. A **meta** key, not a column (ADR-0060). (`db.ts:502`)
- **buildComplete** — pr-watch latch: true once **stage** first hits `milad-review` (build sealed). A
  **meta** key, not a column (ADR-0060).
- **gate** — the pr-watch invariant: a PR clears internal agent review AND Milad's own review before ANY
  public review is requested. (cluster constitution)
- **board / gate / pending** — the **cluster state** docs the **control** loop senses and `!`-injects each
  tick (the board of PRs, the gate status, the pending-events summary). (`engine/scripts`)
- **sense** — the engine step that reads git/GitHub/Slack facts and writes them to **cluster state**
  (`catalogue_sync.py`, `sense.sh`); state is sensor-driven, never session-remembered.
- **tick** — one cadence beat of a **loop** role (e.g. control every 15m), re-armed by **resume_command**.
- **mark** — `ccs mark`, the control-owned lifecycle transition (**completed**/**archived**); workers never
  self-**mark**. (`db.ts` setCompleted/setArchived)
