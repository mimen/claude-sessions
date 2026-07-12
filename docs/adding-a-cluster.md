# Adding a cluster to ccs

A step-by-step guide to standing up a new cluster from scratch. This is the manual procedure; a front-door wizard (task #11) will automate it later. Once you have a cluster, see [adding-a-role.md](adding-a-role.md) for extending it with new roles.

See also: [CONTEXT.md](CONTEXT.md) (platform mental model), [GLOSSARY.md](GLOSSARY.md) (term definitions), [runbook.md](runbook.md) (operating the platform).

---

## What is a cluster?

A **cluster** is a named set of sessions that run one operation together (e.g. `pr-watch`). It's a self-contained package: roles + engine + docs, all under `~/.ccs-config/clusters/<name>/`. The platform concept is the **cluster**; pr-watch is one instance of it.

A cluster has:
- **Core roles** — singleton infrastructure (control, concierge, scout, eval, designer). One embodiment per role.
- **Fleet roles** — per-work-unit workers (pr-agents). One embodiment per work-unit.
- **An engine** (optional) — sensing scripts, gate logic, policy enforcement. Cluster-specific code that reads external state (git/GitHub/Slack) and writes it to **cluster state**.
- **Cluster state** — runtime JSON docs under `~/.ccs/clusters/<name>/cluster/` (board, gate, pending, grouping metadata). Sensed by the engine, read by roles.
- **A manifest** (`cluster.toml`) — declares the cluster's name, engine path, and sense entry point.

**The cluster is the axis sessions are filed under** (ADR-0059) — it's a first-class column in the catalogue. The DB column `system` is being renamed to `cluster`.

---

## Minimal cluster structure (what you need)

A minimal cluster needs:

```
~/.ccs-config/clusters/<name>/
  cluster.toml              ← REQUIRED (manifest)
  roles/                    ← REQUIRED (at least one role)
    <role>/
      role.toml
      skills/
      commands/
      .ccs-hooks/
  .ccs-hooks/               ← optional (cluster-level hooks)
    claude-md.md
    meta-update.json
  engine/                   ← optional (sensing/gate scripts)
    scripts/
      sense.sh              ← entry point for sensing
      ...
  docs/                     ← optional but recommended
    runbook.md
    README.md
```

**Derived from position:**
- **cluster name** = the directory name itself (`clusters/<name>/` → cluster = `<name>`)
- **roles** = subdirectories under `roles/` (see [adding-a-role.md](adding-a-role.md))

**Authored in `cluster.toml`:**
- **name** (canonical cluster name, should match directory)
- **engine** (path to engine dir, package-relative)
- **sense** (path to sense entry point, package-relative)

---

## Step-by-step: Standing up a new cluster

We'll use `event-watch` as the example — a hypothetical cluster that watches Slack events and routes them.

### 1. Create the cluster directory

Under `~/.ccs-config/clusters/`:

```bash
mkdir -p ~/.ccs-config/clusters/event-watch
cd ~/.ccs-config/clusters/event-watch
```

### 2. Author `cluster.toml` (the manifest)

Create the cluster manifest:

```bash
cat > cluster.toml <<'EOF'
# The event-watch cluster manifest (ADR-0048). A cluster is a self-contained package:
# definitions (roles/, epics/), the executable engine (engine/), and this manifest.
# Runtime state lives in ~/.ccs/clusters/event-watch (never here). The engine is invoked
# at engine-relative paths, so the whole package is location-independent — clone it
# anywhere and it runs.
name = "event-watch"

# The cluster's executable engine (sensing/gate/policy scripts). Package-relative.
engine = "engine"

# How the control loop runs the engine's sense pass (package-relative entry).
sense = "engine/scripts/sense.sh"
EOF
```

**Fields:**
- **name** — canonical cluster name (must match the directory name for consistency).
- **engine** — path to the engine directory, relative to the cluster package root. This is where sensing scripts live.
- **sense** — path to the sense entry point (the script the control loop invokes), relative to the cluster package root.

If your cluster has no engine (no external sensing), you can omit `engine` and `sense`. Most clusters will have an engine.

### 3. Create the roles directory and add your first role

Every cluster needs at least one role. Start with a core role (e.g. `control`):

```bash
mkdir -p roles/control
cd roles/control

cat > role.toml <<'EOF'
kind = "loop"
resume_command = "/loop 15m /event-watch-control"
EOF

mkdir -p skills/event-watch-control
cat > skills/event-watch-control/SKILL.md <<'EOF'
# event-watch control skill

The control plane for event-watch: sense events, route to workers, advance state.
EOF

mkdir -p .ccs-hooks
cat > .ccs-hooks/claude-md.md <<'EOF'
## event-watch control

You are the control plane for event-watch. Sense events, route to workers, never talk to Milad.
EOF

cd ../..
```

See [adding-a-role.md](adding-a-role.md) for the full role-creation guide. Add more roles as needed (concierge, workers, etc.).

### 4. (Optional) Add cluster-level hooks

Cluster-level hooks apply to ALL roles in the cluster. Common use: shared context injection (`claude-md.md`) or cluster-wide metadata refresh (`meta-update.json`).

```bash
mkdir -p .ccs-hooks

cat > .ccs-hooks/claude-md.md <<'EOF'
## event-watch constitution
<!-- ccs:floor -->
You are part of the **event-watch** fleet. Core rules:

- **Never post on Milad's behalf without explicit approval.**
- **The gate:** an event clears internal review before any external action.
- **Lifecycle is control's, not yours.** Workers never mark themselves completed.
EOF

cat > .ccs-hooks/meta-update.json <<'EOF'
{
  "fields": ["stage", "activity", "statusLine"]
}
EOF
```

Hook resolution is layered (`user → cluster → role → epic → work-unit → identity`). Cluster-level hooks sit between user-level and role-level; see [GLOSSARY.md](GLOSSARY.md) for merge strategies.

### 5. (Optional) Create the engine

The engine reads external state (git, GitHub, Slack, CI) and writes it to **cluster state** under `~/.ccs/clusters/<name>/cluster/`. This is what makes the cluster autonomous: control senses and acts on facts, not session memory.

#### 5.1 Create the engine directory

```bash
mkdir -p engine/scripts
mkdir -p engine/lib
```

#### 5.2 Write the sense entry point

The `sense.sh` script is what control invokes each tick to refresh cluster state. Example:

```bash
cat > engine/scripts/sense.sh <<'EOF'
#!/usr/bin/env bash
# event-watch sense pass: read Slack, GitHub, compute board + pending events.
set -euo pipefail

CLUSTER_STATE="$HOME/.ccs/clusters/event-watch/cluster"
mkdir -p "$CLUSTER_STATE"

# Sense Slack events (example)
python3 "$(dirname "$0")/sense_slack.py" > "$CLUSTER_STATE/events.json.tmp"
mv "$CLUSTER_STATE/events.json.tmp" "$CLUSTER_STATE/events.json"

# Compute the board (which events need routing)
python3 "$(dirname "$0")/compose_board.py" > "$CLUSTER_STATE/board.json.tmp"
mv "$CLUSTER_STATE/board.json.tmp" "$CLUSTER_STATE/board.json"

echo "sense complete: events + board refreshed"
EOF

chmod +x engine/scripts/sense.sh
```

#### 5.3 Write sensing scripts (example)

```bash
cat > engine/scripts/sense_slack.py <<'EOF'
#!/usr/bin/env python3
"""Sense Slack events and write to cluster state."""
import json
import os
from pathlib import Path

# Read Slack (placeholder — integrate with Slack MCP / API)
events = [
    {"id": "evt_001", "channel": "#eng", "text": "Deploy blocked", "ts": "2026-07-11T12:00:00Z"},
    {"id": "evt_002", "channel": "#incidents", "text": "P1 alert", "ts": "2026-07-11T12:05:00Z"},
]

# Write to cluster state
print(json.dumps({"events": events, "updatedAt": "2026-07-11T12:10:00Z"}))
EOF

chmod +x engine/scripts/sense_slack.py

cat > engine/scripts/compose_board.py <<'EOF'
#!/usr/bin/env python3
"""Compose the board from sensed events."""
import json
from pathlib import Path

cluster_state = Path.home() / ".ccs/clusters/event-watch/cluster"
events_path = cluster_state / "events.json"

if not events_path.exists():
    board = {"events": [], "needsRouting": []}
else:
    with open(events_path) as f:
        data = json.load(f)
    events = data.get("events", [])
    # Filter for events that need routing (example logic)
    needs_routing = [e for e in events if "blocked" in e["text"].lower() or "P1" in e["text"]]
    board = {"events": events, "needsRouting": needs_routing}

print(json.dumps(board))
EOF

chmod +x engine/scripts/compose_board.py
```

The engine is cluster-specific code. pr-watch's engine has ~30 scripts (`catalogue_sync.py`, `gate_eval.py`, `poll.py`, etc.). Start minimal; grow as needed.

#### 5.4 Test the sense pass

```bash
./engine/scripts/sense.sh
```

Check that cluster state was written:

```bash
ls -la ~/.ccs/clusters/event-watch/cluster/
cat ~/.ccs/clusters/event-watch/cluster/board.json
```

### 6. (Optional) Add cluster docs

Document the cluster's operation, runbook, and architecture:

```bash
mkdir -p docs

cat > docs/README.md <<'EOF'
# event-watch cluster

Watches Slack events and routes them to workers for triage + response.

## Roles

- **control** — senses events, routes to workers, advances state
- **concierge** — talks to Milad, surfaces urgent events
- **event-agent** — fleet worker, owns one event

## Engine

The engine (`engine/scripts/sense.sh`) reads Slack and computes the board. Control invokes it every 15 minutes.

## State

- `~/.ccs/clusters/event-watch/cluster/events.json` — sensed Slack events
- `~/.ccs/clusters/event-watch/cluster/board.json` — board of events needing routing
EOF

cat > docs/runbook.md <<'EOF'
# event-watch runbook

## Resuming the cluster

```bash
ccs resume-cluster event-watch
```

## Sensing manually

```bash
~/.ccs-config/clusters/event-watch/engine/scripts/sense.sh
```

## Checking the board

```bash
cat ~/.ccs/clusters/event-watch/cluster/board.json | jq .
```
EOF
```

### 7. Initialize cluster state (if needed)

If your cluster needs seed state (groupings, initial board, config), create it under `~/.ccs/clusters/<name>/cluster/`:

```bash
mkdir -p ~/.ccs/clusters/event-watch/cluster

cat > ~/.ccs/clusters/event-watch/cluster/groupings.json <<'EOF'
{
  "schemaVersion": 1,
  "updatedAt": "2026-07-11T12:00:00Z",
  "source": "manual-seed",
  "data": {
    "groupings": []
  }
}
EOF
```

Cluster state lives in `~/.ccs` (runtime), not `~/.ccs-config` (definitions). This is the three-homes contract (ADR-0041/0049).

### 8. Run `ccs sync-roles` to materialize the roles

```bash
ccs sync-roles
```

This scans `~/.ccs-config/clusters/*/roles/` and materializes skills/commands into `~/.claude/`. You need this for the cluster's roles to wire up.

### 9. Verify the cluster is recognized

Check that ccs sees the cluster:

```bash
ccs ls --cluster event-watch
```

Should show no sessions yet (cluster exists, but no sessions filed under it).

Check the roles:

```bash
ccs roles ls
```

Your cluster's roles should appear.

### 10. Spawn the first session (control)

Spawn the control role:

```bash
ccs new-session --role control --cluster event-watch
```

The session spawns into a fresh cmux workspace. If it's a loop role (like control), it comes back running (the resume_command fires at SessionStart).

### 11. Add more roles and resume the cluster

Add more roles (concierge, workers, etc.) per [adding-a-role.md](adding-a-role.md). When ready, resume the whole cluster:

```bash
ccs resume-cluster event-watch
```

This resumes every not-open session filed under `event-watch`, with **supersede-dedup** (one embodiment per work-unit).

---

## How sessions get filed under a cluster (the cluster axis)

A session is filed under a cluster via the `cluster` column in the catalogue (ADR-0059). The DB column `system` is being renamed to `cluster` — they're the same concept.

**At spawn:**
```bash
ccs new-session --role <role> --cluster <cluster>
```

The `--cluster` flag writes the cluster to the CatalogueRow. The session is now part of that cluster's fleet.

**At query:**
```bash
ccs ls --cluster <cluster>
ccs resume-cluster <cluster>
```

These resolve to all sessions where `CatalogueRow.cluster = <cluster>`.

**The cluster axis is how control knows which sessions to drive.** Control is itself a session filed under the cluster; it queries its own cluster to find the fleet.

---

## Cluster state (the runtime side)

Cluster state lives under `~/.ccs/clusters/<name>/cluster/` (runtime, never git). Common state docs:

- **board.json** — the work board (PRs, events, tasks). Sensed by the engine, read by control.
- **gate.json** — gate status (which items cleared review, which are blocked). Computed by the engine.
- **pending.json** — pending events summary (Slack messages, CI failures). Sensed by the engine.
- **groupings.json** — grouping display metadata (epic labels, URLs, notes). Written by control/concierge, read by renderers.
- **work-units.json** — work-unit entities (per ADR-0057, as it lands). Keyed by work-unit id, holds PR/GUS/anchor attributes.

State docs are written atomically (temp+rename) and wrapped in an envelope (`{schemaVersion, updatedAt, source, data}`). See `src/state/store.ts` for the primitives.

**The engine writes state; roles read it.** State is sensor-driven, never session-remembered. This is what makes the cluster resilient to session crashes: all facts are external, re-sensed each tick.

---

## The worked example: pr-watch

The pr-watch cluster is the reference implementation. Its layout:

```
~/.ccs-config/clusters/pr-watch/
  cluster.toml              ← manifest (name, engine, sense)
  roles/                    ← 6 roles (control, concierge, pr-agent, slack-scout, eval, designer)
    control/
      role.toml             ← kind = "loop", resume_command = "/loop 15m /pr-watch-control"
      skills/
        pr-watch-control/
      .ccs-hooks/
        claude-md.md        ← context injection
        cmux-paint.json     ← tab appearance
    concierge/
      ...
    pr-agent/
      role.toml             ← kind = "session" (fleet worker, no loop)
      ...
    slack-scout/
      ...
    eval/
      ...
    designer/
      ...
  .ccs-hooks/               ← cluster-level hooks (constitution, roster)
    claude-md.md
    meta-update.json
  engine/                   ← sensing/gate/policy scripts (Python)
    scripts/
      sense.sh              ← entry point (invoked by control)
      catalogue_sync.py     ← syncs PR facts from GitHub to catalogue
      compose_board.py      ← composes the board from sensed state
      gate_eval.py          ← evaluates the gate (internal + Milad review)
      poll.py               ← polls GitHub for PR state changes
      ...
    lib/                    ← shared engine utilities
    seed/                   ← seed data (config, changelog, standards)
    deploy/                 ← deployment config (cron, plist)
  epics/                    ← grouping definitions (epic display metadata)
    a3QEE000002HbWf2AK/
      meta.json
  docs/                     ← cluster-specific docs
    runbook.md
    CONTEXT.md
    tickets.md
```

**Runtime state** (under `~/.ccs/clusters/pr-watch/cluster/`):
- `board.json` — PRs on the board
- `gate.json` — gate status
- `pending.json` — pending events (Slack, CI)
- `groupings.json` — epic metadata (labels, URLs)

Read pr-watch's files for patterns to copy. The engine is the most cluster-specific part; the roles follow common patterns.

---

## Core vs fleet in your cluster

Every cluster has:
- **Core roles** — singleton infrastructure. One embodiment per role. No work-unit.
  - `control` — senses, routes, advances, owns lifecycle.
  - `concierge` — talks to Milad, surfaces priorities.
  - `scout` (optional) — senses external channels (Slack, email).
  - `eval` (optional) — grades the loop, proposes improvements.
  - `designer` (optional) — designs the loop, not in the live flow.

- **Fleet roles** — per-work-unit workers. One embodiment per work-unit. Tied to PR/GUS/event/etc.
  - `pr-agent` (pr-watch) — owns one PR.
  - `event-agent` (event-watch) — owns one event.
  - `incident-agent` (incident-watch) — owns one incident.

The platform enforces **one-embodiment** for fleet roles (spawn contract + supersede-dedup). Core roles bypass the check.

---

## The control loop pattern (cadence-driven)

Most clusters follow the control loop pattern:
1. **Sense** — the engine reads external state (git/GitHub/Slack/CI) and writes cluster state.
2. **Drain** — control drains pending events from the board.
3. **Route** — control routes work to fleet workers (via inbox).
4. **Advance** — control advances in-flight work (check status, unblock, update stage).
5. **Mark** — control marks completed work (lifecycle transitions).

The control role is a **loop** (`kind = "loop"`, `resume_command = "/loop 15m /pr-watch-control"`). It re-arms every 15 minutes, senses, and drives the fleet. It never talks to Milad; that's concierge's job.

**The control loop never runs `ccs resume`.** Resuming the cluster is Milad's explicit action or a scheduler (cron / launchd). The control tick must never spawn/resume sessions itself — it routes work to existing workers, but doesn't create them. This is a constitutional rule to prevent duplicate-fleet runaway.

---

## Bringing up the cluster (the operational flow)

1. **Create the cluster package** under `~/.ccs-config/clusters/<name>/` (steps 1-7 above).
2. **Run `ccs sync-roles`** to materialize the roles.
3. **Spawn the core roles** (control, concierge, etc.):
   ```bash
   ccs new-session --role control --cluster <name>
   ccs new-session --role concierge --cluster <name>
   ```
4. **Resume the cluster** to bring up any closed sessions:
   ```bash
   ccs resume-cluster <name>
   ```
5. **Verify liveness**:
   ```bash
   ccs ls --cluster <name>
   ```
   All core roles should show as open.

6. **(Optional) Set up a cron / launchd job** to resume the cluster on boot / wake. pr-watch has a launchd plist (`engine/deploy/com.mimen.pr-watch-control.plist`) that resumes the cluster on system wake. Do NOT cron `ccs resume` inside the control loop itself — it's Milad's action or the scheduler's, never the control tick's.

---

## Common pitfalls

1. **Forgetting to run `ccs sync-roles` after creating the cluster.** The roles are readable (ccs sees them), but skills/commands won't wire up into `~/.claude/` until you materialize them.

2. **Running `ccs resume` inside the control loop.** This causes duplicate-fleet runaway (the 12120/12121 bug). Control routes work; it doesn't spawn workers. Resuming is Milad's action or a scheduler's.

3. **Storing cluster state under `~/.ccs-config`.** Cluster state is RUNTIME (`~/.ccs/clusters/<name>/cluster/`), never definitions (`~/.ccs-config`). The three-homes contract (ADR-0041/0049): definitions git-tracked in config, state never git.

4. **Hardcoding cluster-specific vocabulary in the tool.** Per ADR-0061, ccs provides generic mechanism; the cluster provides typed vocabulary. If a second cluster would inherit a field/column/enum it doesn't use, that thing belongs in cluster config, not the tool.

5. **Spawning a fleet role without a work-unit.** Fleet roles need a `--pr` or `--gus` anchor. Without it, the spawn contract computes the work-unit as null and passes it through — the one-embodiment guarantee is lost.

---

## Where things live (the map)

- **Cluster definitions (source of truth):** `~/.ccs-config/clusters/<name>/`
  - `cluster.toml`, `roles/`, `.ccs-hooks/`, `engine/`, `docs/`
- **Cluster state (runtime):** `~/.ccs/clusters/<name>/cluster/`
  - `board.json`, `gate.json`, `pending.json`, `groupings.json`, `work-units.json`
- **Identity runtime (per-role inbox/state):** `~/.ccs/identities/<responsibility>/`
- **Catalogue (session metadata):** `~/.ccs/cache/catalogue.db` (one row per session, includes `cluster` column)
- **Index (transcript cache):** `~/.ccs/cache/index.db`

---

## Next steps

- **To add a role to this cluster:** see [adding-a-role.md](adding-a-role.md).
- **To operate the cluster** (resume, liveness, cmux coupling): see [runbook.md](runbook.md).
- **To understand the platform concepts:** see [CONTEXT.md](CONTEXT.md) and [GLOSSARY.md](GLOSSARY.md).
- **For pr-watch specifically:** see `~/.ccs-config/clusters/pr-watch/docs/runbook.md`.
