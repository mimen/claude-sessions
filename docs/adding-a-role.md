# Adding a role to an existing cluster

A step-by-step guide to adding a new role to an existing ccs cluster. This covers the manual procedure; a front-door wizard (task #11) will automate this later.

See also: [CONTEXT.md](CONTEXT.md) (platform mental model), [GLOSSARY.md](GLOSSARY.md) (term definitions), [adding-a-cluster.md](adding-a-cluster.md) (standing up a new cluster from scratch), [runbook.md](runbook.md) (operating the platform).

---

## What is a role?

A **role** is a session's first-class identity: what it *is* (`control`, `concierge`, `pr-agent`). It drives which **skills**, **commands**, and **hooks** materialize. A role is defined by its directory structure under a cluster's `roles/` tree and its `role.toml` manifest.

Roles come in two flavors:
- **core** — singleton infrastructure roles (control/concierge/scout/eval/designer). One embodiment per cluster, never tied to a work-unit. Declared as `work_unit = "none"` (per ADR-0069, when that property lands).
- **fleet** — per-work-unit workers (pr-agents). One embodiment per work-unit. Tied to a PR, GUS ticket, or other work anchor. Declared with a `work_unit` anchor type (e.g. `work_unit = "pr"`).

---

## The role directory structure (what gets DERIVED)

A role is a directory under `~/.ccs-config/clusters/<cluster>/roles/<role>/`. The platform derives most of a role's definition from POSITION and FILE PRESENCE (ADR-0050) — no cache, files are truth:

```
roles/<role>/
  role.toml               ← AUTHORED (kind, resume_command, and future properties)
  skills/                 ← names present here become the role's skills
    <skill-name>/
      SKILL.md
  commands/               ← *.md base-names become the role's commands
    <command-name>.md
  .ccs-hooks/             ← hook-type names present here (file-presence)
    claude-md.md
    start.json
    cmux-paint.json
    ...
  docs/                   ← optional; role-specific docs
```

**Derived from directory:**
- **role name** = the directory name itself
- **cluster** = the parent path (`clusters/<cluster>/roles/<role>`) or `null` (standalone roles, rare)
- **homeDir** = the directory itself (computed at load, never stored as an absolute path)
- **skills[]** = names of dirs/files present under `skills/` (e.g. `skills/pr-watch-eval/` → `["pr-watch-eval"]`)
- **commands[]** = base-names of `*.md` files under `commands/` (e.g. `commands/approve.md` → `["approve"]`)
- **hooks[]** = hook-type names present under `.ccs-hooks/` (e.g. `.ccs-hooks/start.json` → `["start"]`)

**Authored in `role.toml`:**
- **kind** — `"loop"` (re-arms on resume) or `"session"` (bare). Currently required.
- **resume_command** — the command a loop re-fires on resume (e.g. `"/loop 15m /pr-watch-control"`). Present iff `kind = "loop"`.
- **Future properties (per ADR-0062/0069, as they land):**
  - `topology` or `work_unit` — declares core vs fleet (e.g. `work_unit = "none"` for core, `work_unit = "pr"` for fleet).
  - Other role-specific properties as the platform evolves.

---

## Step-by-step: Adding a new role

### 1. Create the role directory

Under your cluster's `roles/` tree:

```bash
mkdir -p ~/.ccs-config/clusters/<cluster>/roles/<new-role>
cd ~/.ccs-config/clusters/<cluster>/roles/<new-role>
```

Example (pr-watch cluster, adding a `metrics` role):

```bash
mkdir -p ~/.ccs-config/clusters/pr-watch/roles/metrics
cd ~/.ccs-config/clusters/pr-watch/roles/metrics
```

### 2. Author `role.toml` (the non-derivable properties)

Create `role.toml` with the role's behavioral properties. Current shape (per `src/roles/role-files.ts`):

```toml
kind = "loop"                          # or "session"
resume_command = "/loop 30m /metrics"  # if kind = "loop"; command to re-arm
```

- **kind = "loop"** → the role re-arms on resume (comes back running). Must have a `resume_command`.
- **kind = "session"** → bare resume; rehydrates from inbox/state. No `resume_command`.

Example (`metrics` is a loop role that runs every 30 minutes):

```toml
kind = "loop"
resume_command = "/loop 30m /metrics"
```

Example (a worker role that doesn't loop):

```toml
kind = "session"
```

**Future:** per ADR-0062/0069, `topology`/`work_unit` will declare core-vs-fleet and anchor type. Watch the code for when those land; update this doc then.

### 3. Add skills (if any)

If the role provides slash-command skills, create `skills/<skill-name>/SKILL.md`:

```bash
mkdir -p skills/metrics
cat > skills/metrics/SKILL.md <<'EOF'
# Metrics dashboard skill

Show cluster health metrics.

## Usage

/metrics [--verbose]

## Output

- PR throughput
- Agent uptime
- Queue depth
EOF
```

The skill name (`metrics`) is derived from the directory name. The `SKILL.md` is the skill's definition/prompt.

### 4. Add commands (if any)

If the role provides direct ccs commands, create `commands/<command-name>.md`:

```bash
mkdir -p commands
cat > commands/metrics.md <<'EOF'
# metrics command

Display cluster metrics dashboard.
EOF
```

The command name (`metrics`) is derived from the markdown file's base-name. The `.md` is the command's help/definition.

### 5. Add hooks (if any)

Hooks fire at Claude lifecycle moments (SessionStart, Stop, etc.). If the role needs custom behavior, add `.ccs-hooks/<type>.{json,md}`:

```bash
mkdir -p .ccs-hooks

# SessionStart hook (inject context)
cat > .ccs-hooks/claude-md.md <<'EOF'
## Metrics role context

You are the metrics dashboard role. Poll cluster state and report health.
EOF

# cmux tab appearance override
cat > .ccs-hooks/cmux-paint.json <<'EOF'
{
  "color": "#00ff00",
  "icon": "📊"
}
EOF
```

Common hook types:
- **claude-md** (`.md`) — injected into the session's CLAUDE.md context at SessionStart (merge strategy: `sections`)
- **start** (`.json`) — actions to run at SessionStart (merge strategy: `ordered-actions`)
- **stop** (`.json`) — actions to run at Stop (merge strategy: `ordered-actions`)
- **cmux-paint** (`.json`) — tab appearance override (merge strategy: `most-specific`)
- **statusline** (`.json`) — statusline override (merge strategy: `most-specific`)
- **meta-update** (`.json`) — which CatalogueRow fields to refresh at Stop (merge strategy: `set-union`)
- **spawn-location** (`.json`) — where to spawn this role (merge strategy: `most-specific`)
- **guard** (`.json`) — permission guards (merge strategy: `union-deny-wins`)

See the existing roles for examples (`~/.ccs-config/clusters/pr-watch/roles/*/. ccs-hooks/`).

### 6. (Optional) Add role-specific docs

If the role is complex, document it:

```bash
mkdir -p docs
cat > docs/README.md <<'EOF'
# Metrics role

Polls cluster state every 30 minutes and reports health metrics.

## Responsibilities

- Track PR throughput
- Monitor agent uptime
- Alert on queue depth spikes

## State

Reads `~/.ccs/clusters/<cluster>/cluster/board.json` and `gate.json`.
EOF
```

### 7. Run `ccs sync-roles` to materialize the role

The role is now defined in `~/.ccs-config`, but ccs needs to materialize it into the runtime (`~/.ccs`) so sessions can reference it. Run:

```bash
ccs sync-roles
```

This scans `~/.ccs-config/clusters/*/roles/` and materializes skills/commands into `~/.claude/` (per ADR-0051, the old materialization contract; this may change). You do NOT need to run `sync-roles` for ccs to READ the role definition (ADR-0050, files are truth) — but you DO need it to wire up the skills/commands so Claude sees them.

**When to re-run:** any time you add/remove skills, commands, or hooks. Editing an existing hook's content does NOT require `sync-roles` (files are read directly). Adding a NEW hook file DOES (file-presence drives the derived hooks list).

### 8. Verify the role is recognized

Check that ccs sees the role:

```bash
ccs roles ls
```

Your new role should appear in the list. Check its definition:

```bash
ccs roles show <new-role>
```

This reads the role.toml + derived structure and shows the resolved RoleDef.

### 9. Spawn a session with the new role

For a **core** role (singleton, no work-unit):

```bash
ccs new-session --role <new-role> --cluster <cluster>
```

Example:

```bash
ccs new-session --role metrics --cluster pr-watch
```

For a **fleet** role (tied to a work-unit, e.g. a PR):

```bash
ccs new-session --role <new-role> --cluster <cluster> --pr <owner/repo#number>
```

Example (assuming a `pr-reviewer` fleet role):

```bash
ccs new-session --role pr-reviewer --cluster pr-watch --pr myorg/myrepo#456
```

The session spawns into a fresh cmux workspace. If it's a loop role, it comes back running (the resume_command fires at SessionStart via the **arm** action).

### 10. Resume the role (if it's a singleton)

For core roles, you typically want to resume the existing session rather than spawn a new one:

```bash
ccs resume <new-role>
```

If the role is already embodied (live), this is a no-op (idempotent). If closed, it resumes.

---

## What gets derived vs what gets authored (the contract)

**Derived from directory structure** (read on every access, no cache):
- role name (directory name)
- cluster (parent path)
- homeDir (directory path, computed at load)
- skills[] (names under `skills/`)
- commands[] (base-names under `commands/*.md`)
- hooks[] (types under `.ccs-hooks/<type>.{md,json}`)

**Authored in `role.toml`** (the non-derivable bits):
- kind (`"loop"` or `"session"`)
- resume_command (if kind = "loop")
- (future) topology / work_unit (core vs fleet, anchor type)

**Never stored in the catalogue** (ADR-0062):
- `resume_command` used to be cached per session; it's now role-only (read from role.toml at resume).
- `kind` used to be cached per session; it's now derived from `resume_command != null` on the role.

The role directory is the source of truth; editing a file takes effect immediately for reads (no `sync-roles` needed). Materialization (`sync-roles`) is only for wiring up skills/commands/hooks into `~/.claude/`.

---

## Core vs fleet roles (the distinction)

**Core roles:**
- One embodiment per cluster (singleton).
- No work-unit. They are infrastructure: control, concierge, scout, eval, designer.
- Declared as `work_unit = "none"` (per ADR-0069, when that lands).
- Spawned with `--role <role> --cluster <cluster>` (no PR/GUS).
- Never deduplicated by work-unit (the spawn contract passes them through).

**Fleet roles:**
- One embodiment per work-unit (pr-agents).
- Tied to a PR, GUS ticket, or other work. Each worker owns one unit of work.
- Declared with an anchor type (e.g. `work_unit = "pr"` per ADR-0069).
- Spawned with `--role <role> --cluster <cluster> --pr <repo#num>` (or `--gus <W-id>`).
- Subject to the **one-embodiment rule** (spawn contract refuses if the work-unit is already live).

The platform enforces one-embodiment for fleet roles; core roles bypass the check.

---

## Examples from pr-watch

### Core loop role: `control`

```
roles/control/
  role.toml               ← kind = "loop", resume_command = "/loop 15m /pr-watch-control"
  skills/
    pr-watch-control/
      SKILL.md
  commands/
    pr-watch-control.md
  .ccs-hooks/
    claude-md.md          ← context injection
    start.json            ← arm + drain-inbox
    cmux-paint.json       ← tab appearance (Purple, control icon)
```

`role.toml`:
```toml
kind = "loop"
resume_command = "/loop 15m /pr-watch-control"
```

This role runs every 15 minutes, senses the board, drains events, routes work to workers, and advances in-flight PRs. It's a core role (singleton), so it's spawned without a work-unit.

### Fleet worker role: `pr-agent`

```
roles/pr-agent/
  role.toml               ← kind = "session" (no loop)
  skills/
    pr-watch/
      SKILL.md
  commands/
    status.md
  .ccs-hooks/
    claude-md.md          ← worker-specific context
    start.json            ← drain-inbox
    cmux-paint.json       ← tab appearance (varies by stage)
```

`role.toml`:
```toml
kind = "session"
```

This role is a fleet worker. Each instance owns one PR (work-unit). It's spawned with `--pr <repo#num>`. The spawn contract enforces one-embodiment: only one live pr-agent per PR.

---

## Common pitfalls

1. **Forgetting `ccs sync-roles` after adding a skill/command.** The role is readable (ccs sees it), but the skill/command won't wire up into `~/.claude/` until you materialize it.

2. **Authoring `homeDir` in role.toml.** The homeDir is DERIVED (directory path), never authored. Storing an absolute path breaks portability (ADR-0050).

3. **Spawning a fleet role without a work-unit.** Fleet roles need a `--pr` or `--gus` anchor. Without it, the spawn contract computes the work-unit as null and (currently) passes it through without dedup — the one-embodiment guarantee is lost.

4. **Expecting `kind` to control tab color.** The old platform behavior (loop = Purple tab) is gone (ADR-0062). Tab appearance is now cluster-controlled via **cmux-paint** hooks and render rules.

5. **Caching resume_command per session.** The per-session `resume_command` cache is gone (ADR-0062). A session always re-arms from its role's `role.toml`. If you change the resume_command in role.toml, the next resume picks it up.

---

## Where things live (the map)

- **Role definitions (source of truth):** `~/.ccs-config/clusters/<cluster>/roles/<role>/`
- **Materialized skills/commands:** `~/.claude/` (the old contract; may change)
- **Identity runtime (inbox/state):** `~/.ccs/identities/<responsibility>/` (keyed by role + work-unit)
- **Cluster state:** `~/.ccs/clusters/<cluster>/cluster/*.json`
- **Catalogue (session metadata):** `~/.ccs/cache/catalogue.db` (one row per session, includes `role` column)
- **Index (transcript cache):** `~/.ccs/cache/index.db`

---

## Next steps

- **To stand up a new cluster** (not just a new role): see [adding-a-cluster.md](adding-a-cluster.md).
- **To operate the platform** (resume, liveness, cmux coupling): see [runbook.md](runbook.md).
- **To understand the platform concepts:** see [CONTEXT.md](CONTEXT.md) and [GLOSSARY.md](GLOSSARY.md).
- **For the pr-watch cluster specifically:** see `~/.ccs-config/clusters/pr-watch/docs/runbook.md`.
