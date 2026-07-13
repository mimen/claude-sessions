# Agents sense the cluster roster via `ccs cluster --json`, not a per-cluster registry

Decided with Milad 2026-07-12. Applies the sensed-not-remembered principle (ADR-0031) to the
WORKER roster: a loop should see all active sessions from a deterministic CLI query each tick and
notice a new/closed one automatically ("oh, there's another"), rather than tracking membership in
bespoke bookkeeping. Builds on the work-unit entity (ADR-0057) + the cluster map + surface-keyed
liveness (ADR-0014/0040/0073).

## The gap

Two rosters drive pr-watch, sensed differently:
- **The PR/work roster** (which PRs need attention) — already fully SENSED every tick from
  GitHub + GUS (`membership.py`, both directions). A new PR is discovered automatically.
- **The WORKER-SESSION roster** (which sessions are alive for which work-unit) — control learned
  this from `liveness.json` (sensed) PLUS the `sessions.json` registry that `spawn-agent.sh` writes
  at spawn (remembered). There was no single CLI query giving "all sessions in the cluster, core +
  fleet, live-or-not, by work-unit" that an agent could consume in its tick. So a converged board
  read as "nothing to do" without surfacing that in-flight PRs had NO live worker.

The human-readable `ccs cluster <c>` view already existed; what was missing was a machine-readable
form agents can parse, and the roles actually consulting it.

## Decision

**`ccs cluster <c> --json` is the deterministic roster query all cluster agents consume.** It emits
every member (core + fleet) with `live`/`lifecycle`/`prNumber`/`gusWork`/`cwd`/work-unit folds, plus
a **`closedWithWork`** roll-up: fleet sessions that are NOT live and NOT retired — in-flight work
with no running session. Same sensed liveness (surface-UUID bridge) as the human view; pure
projection of the cluster map (no new state).

Roles consult it in their tick:
- **control** injects it and SURFACES `closedWithWork` into its roll-up ("these PRs have work but no
  live worker — reopen") — detect + report, per its no-resume rule (ADR-0073/incident 2026-07-10).
  Control still spawns a FRESH worker for a PR that needs one (`ensure`), and never resumes a dead
  one; reopening a closed session is Milad's action.
- concierge/scout can consume the same query for their own awareness (future wiring).

## Why this shape

- **Sensed, not remembered** (ADR-0031): the roster is derived from the catalogue (durable,
  work-unit-linked) + the live bridge, not the `sessions.json` registry that can drift. A session
  that appears/closes out-of-band is reflected next tick with no bookkeeping.
- **One query, all roles**: the same command serves control's routing, an operator's glance, and
  (later) concierge/scout. The ADR-0061 test — a second cluster gets the roster for free.
- **`closedWithWork` turns "nothing to do" into "here's stalled work"**: the specific signal that a
  converged board with no live workers means work isn't progressing, not that everything's done.

## Consequences

- `ccs cluster` gains `--json` (a `clusterMapToJson` projection: flat members + per-member `folds` +
  `closedWithWork`). No new stored state; a pure view over the existing map.
- control's command block injects the roster; its skill step 6 keys the "surface dead sessions"
  action on `closedWithWork` (not `liveness.json` alone / not the registry).
- Does NOT change the no-resume rule: control reports the closed-with-work list, Milad reopens.
- Future: concierge/scout consult the same query; the `sessions.json` registry can shrink toward
  routing-handles-only as the catalogue roster becomes the source of truth for membership.
- Glossary/units: add **cluster roster** (the sensed `ccs cluster --json` view) + **closedWithWork**.
