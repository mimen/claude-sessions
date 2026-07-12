# ccs platform — mental model and context

What ccs is, how it's laid out, and the core concepts you need to operate or extend it. This is a MENTAL MODEL doc — it introduces the vocabulary and points you to where the details live. For exhaustive definitions, see [GLOSSARY.md](GLOSSARY.md); for system architecture, see [SYSTEM-UNITS.md](SYSTEM-UNITS.md); for operation, see [runbook.md](runbook.md).

---

## What ccs is

**ccs is a session-orchestration platform.** It runs fleets of Claude Code agents as durable, resumable, identity-bearing sessions — each tracked, addressable, and coordinated through a shared catalogue. A **cluster** (like `pr-watch`) defines a multi-role operation: **core** roles (control/concierge/scout/eval/designer) run the infrastructure and talk to you; **fleet** roles (pr-agents) are the workers, each owning one **work-unit** (a PR, a GUS ticket, a piece of work).

ccs provides the MECHANISM (spawn/resume/liveness, identity/inbox/hooks, the catalogue, the rendering). A cluster provides the VOCABULARY and SEMANTICS (what roles do, what a stage means, what work looks like). The platform is generic; clusters are typed (ADR-0061). This split is what makes ccs shippable as a stable tool while fleets iterate in config.

---

## The three homes (know which layer you're touching)

ADR-0041/0049 establish the three-home contract — each has exactly one responsibility:

1. **The ccs TOOL** — `~/projects/claude-sessions` (or wherever the binary lives). The versioned engine, hooks, commands, spawn/resume primitives, and the folder-structure contract. Ships as a release. Pinned to a cmux version range.

2. **`~/.ccs-config`** — your CONFIG, git-tracked, iterated daily. The fleet DEFINITIONS: clusters, roles, hooks, rendering rules. Self-contained cluster packages (roles + engine + docs). Files are the source of truth (ADR-0050). Changed while you work, assuming the tool is stable. This is where the three operator docs (this file, [adding-a-role.md](adding-a-role.md), [adding-a-cluster.md](adding-a-cluster.md)) guide you.

3. **`~/.ccs`** — RUNTIME state, never git. The catalogue + index (`~/.ccs/cache/*.db`), cluster state (`~/.ccs/clusters/<c>/cluster/*.json`), and identity inboxes/scratch (`~/.ccs/identities/...`). Created/updated as work happens; rebuildable or re-sensed (deleting it wipes state but loses nothing durable).

**Operating rule:** a *definition* problem → fix in `~/.ccs-config`. A *state* problem → it's under `~/.ccs` and the tool owns migrating it. A *behavior* problem → the tool.

---

## Core concepts (the vocabulary)

The glossary defines every term precisely. Here's the map:

### Session identity (what a session IS)

- **session** — one Claude Code conversation: a transcript file plus its ccs metadata. The *vessel* — it can close and resume. The **identity** it carries outlives the session.
- **sessionId** — the UUID naming a session (the transcript filename, the PK everywhere).
- **responsibility** — the durable agent-identity key: `{cluster?, role, epic?, workUnit?}`. What a session is *responsible for*. It survives resume.
- **identity** — the runtime context a **responsibility** indexes: its **inbox** and **state**, under `~/.ccs`. "This session's identity" = the durable thing the session embodies.
- **embodiment** — a session actively running in a **surface** (cmux pane) right now. **Liveness** is the presence of an embodiment. One identity has at most one live embodiment (the **one-embodiment rule**).
- **lineage** — earlier embodiments of the same identity, oldest→newest, so a fresh session can review prior attempts.

### Work grouping (how sessions are filed)

- **work-unit** — the specific deliverable a session owns. **A first-class entity with a stable, ccs-minted id** (ADR-0057). A PR, GUS item, cwd/branch, and title attach to it as ATTRIBUTES — they are not its identity. The unit of the one-embodiment rule and the key for lineage. A session references it by FK (`workUnitId`).
- **cluster** — a named set of sessions that run one operation together (e.g. `pr-watch`). The **fleet** plus the **core** roles. Canonical axis (ADR-0059).
- **grouping** — a mid-level work grouping bigger than a work-unit. The platform concept is **grouping**; a grouping has a **type**, and pr-watch uses an **epic**-type grouping. A session carries an `epicId` FK; display metadata lives in **cluster state**.
- **project** — a loose user label grouping otherwise-unrelated sessions (an initiative name). Distinct from **cluster** (operation) and **grouping** (work).
- **key** — an opaque identity-grouping slug. Canonical (ADR-0059).
- **tag** — an ad-hoc many-to-many entity label on a session (`session_tags`).

### Role & kind

- **role** — a session's first-class identity axis: what it *is* (`control`, `concierge`, `slack-scout`, `eval`, `pr-agent`, `designer`). Drives which **skills**/**commands**/**hooks** materialize. Canonical (ADR-0015).
- **kind** — a role's classification: **`loop`** (re-arms on resume via **resume_command**, comes back running) or **`session`** (bare; rehydrates from **inbox**/**state**).
- **core** vs **fleet** — **core** = singleton infrastructure roles (control/concierge/scout/eval/designer); **fleet** = per-work-unit workers (pr-agents). Declared per ADR-0062/0069.
- **role-def** — a role's DEFINITION, read from files (`role.toml` + directory structure), never a DB cache: `{role, cluster, kind, homeDir, resumeCommand, skills[], commands[], hooks[]}` (ADR-0050).
- **role.toml** — the TOML manifest in a role directory holding the non-derivable bits (`kind`, `resume_command`; and per ADR-0062/0069 the `topology`/`work_unit` properties as they land). Everything else is derived from the directory.
- **resume_command** — the command a **loop** re-fires on resume so it comes back running (e.g. `/loop 15m /pr-watch-control`).

### Stores (where state lives)

- **catalogue** — the durable, user/agent-authored metadata store (SQLite, `~/.ccs/cache/catalogue.db`). One **row** per session (**CatalogueRow**). Survives **index** rebuilds.
- **CatalogueRow** — the metadata record for a session: identity axes (role, cluster, key, epicId, gusWork), PR facts, **stage**/**activity**, **statusLine**, **meta** (generic metadata map per ADR-0060), lifecycle bits.
- **index** — the ephemeral cache of parsed transcripts (SQLite, `~/.ccs/cache/index.db`). Dropped and rebuilt on schema bump; pure cache, reconstructable from transcript files. One **SessionRow** per transcript.
- **SessionRow** — the parsed-transcript record: cwd, project, timestamps, **resumeId**, cost/tokens, user-turns, tick cadence, resolved **title**.
- **state doc** — a durable JSON file wrapped in an envelope `{schemaVersion, updatedAt, source, data}`, written atomically (temp+rename), corrupt files quarantined.
- **cluster state** — **state docs** scoped to a cluster (`~/.ccs/clusters/<c>/cluster/*.json`), e.g. **board**/**gate**/**pending**, **grouping** display metadata.
- **inbox** — a durable per-identity file mailbox. Delivery is independent of liveness; a **message** is written atomically, then **drained** move-on-drain into `processed/`.

### cmux embodiment (the terminal substrate)

- **cmux** — the terminal multiplexer ccs runs sessions inside. External binary; the whole **bridge** is coupled to its version (0.64.17).
- **surface** — one cmux pane/tab where a Claude agent runs. Identified by a **surfaceId** (stable UUID).
- **workspace** — a cmux workspace (a tab holding panes/surfaces), identified by a **workspaceId**.
- **tree** — the cmux JSON hierarchy (windows→workspaces→panes→surfaces) from `cmux tree --all --json --id-format both`. Ground truth for "what surface exists now".
- **hook store** — cmux 0.64's `~/.cmuxterm/claude-hook-sessions.json`, populated by cmux's claude shim. Holds `activeSessionsBySurface[surfaceId] → sessionId` (the authoritative binding).
- **bridge** — the surface-keyed link between sessions and their live cmux bodies, built by intersecting the **hook store** bindings with the live **tree**. Answers **liveness**.
- **liveness** — whether a session currently has a live surface (is embodied). Computed by the bridge; exact (surface-UUID join), no title/cwd guessing.
- **readable** — whether the bridge's inputs (the tree command AND the hook store file) were actually read this snapshot. If not readable, spawning operations **fail closed**.

### Spawn / resume

- **spawn** — the birth of a NEW session: mint a **sessionId**, write catalogue metadata, then launch. Governed by the **spawn contract**.
- **resume** — the revival of a CLOSED session: check liveness (skip if already embodied), else `claude --resume <resumeId> [resume_command]` via **spawnCmux**.
- **launch dir** — the directory `claude --resume` must run from so Claude finds the transcript: the real dir whose **path-encoding** matches the transcript's **storage folder**.
- **spawn contract** — the born-correct gate (ADR-0047): a worker spawn is refused unless it passes the **one-embodiment rule** and the **correct-worktree** check. Core roles pass through.
- **one-embodiment rule** — at most one live session per work-unit. Enforced at spawn (contract) and at resume (**supersede-dedup**).
- **supersede-dedup** — in a cluster resume, if a work-unit already has a live session, older dead siblings are superseded (not resumed), so one PR never gets duplicate panes.
- **selector** — a token that resolves to sessionIds: an id, `#pr` / `repo#pr`, `W-id`, a grouping short-name, a role, or a cluster.

### Hooks (deterministic layered config at Claude lifecycle moments)

- **hook** — a config point that fires at a Claude Code moment (SessionStart, Stop, PreToolUse…). Each **hook type** declares a **merge strategy**. Config is **resolved** per session, deterministically.
- **hook type** — one of 8 registered types: **claude-md**, **start**, **stop**, **meta-update**, **cmux-paint**, **statusline**, **spawn-location**, **guard**.
- **level** — one identity layer contributing hook config, ordered broad→specific: `user → cluster → role → epic → work-unit → identity`. Each may hold a `.ccs-hooks/<type>.{md,json}` file.
- **resolution** — the pure computation from a CatalogueRow to the ordered list of levels + their config dirs. Absent file = contributes nothing; no search, no fallback.
- **merge** / **merge strategy** — how a hook type's per-level layers fold into one effective config: `sections` (claude-md), `set-union` (meta-update), `ordered-actions` (start/stop), `most-specific` (cmux-paint/statusline/spawn-location), `union-deny-wins` (guard).
- **start action** — an action in the resolved **start** config run at SessionStart. Built-ins: **arm**, **drain-inbox**.
- **arm** — the start action that re-fires a loop's resume_command on resume so it comes back running.
- **drain** / **drain-inbox** — read pending inbox messages and move them to `processed/` in one atomic step (idempotent).

### Rendering & status

- **tab** — a workspace's rendered cmux tab: `{title, description, color, statusPill}`, synced from the CatalogueRow by **sync-tabs** every turn.
- **pill** — the status indicator on the tab/statusline (`{label, icon, color, priority}`, one key so it never stacks). Rendered from **stage × activity**.
- **statusline** — the single status line ccs renders for a session (stage dot · linked PR · grouping · W-number), staleness-aware.
- **sync-tabs** — the operation that reads the catalogue + cluster state and pushes tab render ops to cmux by surfaceId; never paints **retired** tabs.

### pr-watch phase model (example cluster vocabulary)

- **stage** — a blessed first-class string column ccs stores + displays; its *values* and transitions are defined by the cluster **state machine**, not by ccs (ADR-0060). ccs treats it as monotonic/latched in shape. pr-watch's values: `building → milad-review → in-review → approved → merged`.
- **meta** — a generic per-session map (`Record<string, unknown>`) on the CatalogueRow for role-specific scratch/state-machine storage. ccs stores/stamps/returns it but does NOT interpret it; a cluster adds keys without a schema migration (ADR-0060). **miladReview** and **buildComplete** are meta keys.
- **state machine** — the cluster/role-defined rules over stage/activity: allowed values, legal transitions, when activity clears. Lives in cluster config; ccs provides the columns + meta scratch it needs, not the rules.
- **activity** — the transient state *within* a stage: `working` (resting baseline) / `needs-you` (worker self-reports stuck) / `fixing` (engine-sensed CI/conflict). Orthogonal to stage.
- **gate** — the pr-watch invariant: a PR clears internal agent review AND Milad's own review before ANY public review is requested. (cluster constitution)
- **board / gate / pending** — the cluster state docs the control loop senses and `!`-injects each tick (the board of PRs, the gate status, the pending-events summary).
- **sense** — the engine step that reads git/GitHub/Slack facts and writes them to cluster state; state is sensor-driven, never session-remembered.
- **tick** — one cadence beat of a loop role (e.g. control every 15m), re-armed by resume_command.

---

## How the platform operates (the flows)

### Launching a session

`ccs new-session` mints a sessionId, resolves the **spawn-location** hook, runs the **spawn contract**, writes catalogue metadata (with a forward reference so the session sees itself indexed immediately), then launches via **spawnCmux** into a fresh detached workspace. The session fires **SessionStart** hooks (inject **claude-md** context, run **start actions** like **arm** and **drain-inbox**).

### Resuming sessions

`ccs resume <selector>` resolves the selector (id / `#pr` / `W-id` / epic / role / cluster) to sessionIds. For each: check liveness via the bridge; if already embodied → skip (idempotent). If not readable → abort (fail-closed, ADR-0054). Else build the ResumeCommand and spawnCmux, then eager-paint the tab.

**Cluster resume** (`ccs resume-cluster <cluster>`) resumes every not-open session of a cluster, with **supersede-dedup**: if a work-unit already has a live session, older dead siblings are superseded (not resumed), so one PR never gets duplicate panes. One shared bridge snapshot; fail-closed if unreadable.

### SessionStart & Stop

**SessionStart** hooks fire when a session starts (new or resumed). The resolved **start** config runs actions: **arm** re-fires a loop's resume_command so it comes back running; **drain-inbox** moves pending messages from the inbox into the session. **claude-md** context is injected.

**Stop** hooks run at session end. **meta-update** refreshes declared CatalogueRow fields (a freshness contract, not an auto-writer; external sensors write the values). The tab is re-painted.

### The one-embodiment rule

At most one live session per work-unit. Enforced at spawn (the **spawn contract** refuses a spawn if the work-unit is already embodied) and at resume (supersede-dedup). This prevents the duplicate-fleet bug (12120/12121) where two sessions clobber one PR.

### Identity & continuity

A session's **responsibility** (`{cluster?, role, epic?, workUnit?}`) is its durable identity key. It indexes an **identity** runtime (inbox + state under `~/.ccs`). On resume, **lineage** computes earlier embodiments of the same identity so a fresh session can review prior attempts. A **work-unit** is a first-class entity (ADR-0057) with a stable ccs-minted id; PR/GUS/cwd attach as attributes. Two separate sessions recognize they're the same work by resolving to the same work-unit id (find-or-create by anchor attribute).

### Liveness & the bridge

**Liveness** is exact (surface-UUID join), computed by the **bridge** intersecting the **hook store** bindings with the live **tree**. No title/cwd guessing. If the bridge is **not readable** (cmux down / hook store unreadable), spawning operations **fail closed** — it is always safer to skip a resume than to duplicate a fleet you can't see. The operating rule: always launch and resume through ccs (so cmux's shim registers the session in the hook store).

### Hooks (deterministic layered config)

At a Claude lifecycle moment, ccs resolves the effective hook config by reading each **level**'s `.ccs-hooks/<type>` file (`user → cluster → role → epic → work-unit → identity`) and folding them with the type's **merge strategy**. Absent file = contributes nothing. Result is deterministic, staleness-aware, and degraded-mode-aware (a malformed layer doesn't poison the whole stack).

---

## How to extend the platform

- **Adding a role to an existing cluster:** see [adding-a-role.md](adding-a-role.md).
- **Standing up a new cluster from scratch:** see [adding-a-cluster.md](adding-a-cluster.md).
- **Operating the platform (cmux coupling, resume, liveness, troubleshooting):** see [runbook.md](runbook.md).
- **The pr-watch cluster specifically:** see `~/.ccs-config/clusters/pr-watch/docs/runbook.md`.

---

## The catalogue vs index distinction

The **catalogue** is durable, user/agent-authored metadata. It is the IDENTITY store — sessions filed by role/cluster/work-unit/epic, PR facts, stage/activity/meta, lifecycle. Survives index rebuilds. `~/.ccs/cache/catalogue.db`.

The **index** is ephemeral, rebuildable cache of parsed transcripts. It is the TRANSCRIPT STORE — cwd, timestamps, resumeId, cost, title. Dropped and rebuilt on schema bump; pure cache, no identity. `~/.ccs/cache/index.db`.

The two are joined (session + row, via sessionId) to answer queries like "resume this role" (catalogue membership) + "from which dir" (index launch-dir resolution). But they are architecturally separate: the catalogue is the coordination surface (what ccs tracks); the index is just a parse cache so we don't re-read every transcript on every `ccs ls`.

---

## The platform principle (ADR-0061)

**ccs provides generic mechanism; the cluster provides typed vocabulary.** Neither reaches into the other.

For any concept that varies by cluster:
- **ccs owns:** the generic entity/field/primitive; how it's stored, stamped, indexed, and returned; and any behavioral guarantee worth enforcing platform-wide (atomicity, single-writer, fail-closed, monotonicity).
- **the cluster owns:** the vocabulary (what the values are), the semantics (what they mean, the state machine, the transitions), and the rendering rules (how values become a pill/tab).

The test: would a second, unrelated cluster inherit it? If yes, it's in the wrong layer — it belongs in cluster config, behind a generic ccs mechanism. This is the design rule that makes "stand up event-watch without touching the tool" true rather than aspirational.

Instances: **work-unit** (ADR-0057, ccs provides entity + id + attributes, cluster provides PR/GUS/anchor types), **grouping** (ADR-0059, ccs provides FK, cluster provides epic type + display), **stage × activity + meta** (ADR-0060, ccs provides columns + map + display, cluster provides state machine + semantics).
