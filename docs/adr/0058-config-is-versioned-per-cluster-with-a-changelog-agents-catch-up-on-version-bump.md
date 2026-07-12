# Config is versioned per cluster with a changelog; a start hook makes agents catch up on a version bump

Decided with Milad 2026-07-11, completing the versioning story of the three homes (ADR-0041). Establishes
the inter-layer version contract and adds a NEW mechanism: a running fleet that notices its own config was
bumped and self-updates its behavior by reading the changelog. Mirrors the `drain-inbox` **start action**
(ADR-0033) and the layered-hook model (ADR-0043/0045).

## The framing (Milad's, confirmed against the code)

The three homes (ADR-0041) are three independently **versioned** things, each declaring the contract it
depends on, downward:

- **the ccs TOOL** — the stable, released binary. Locked to a **cmux** version; owns the engine, hooks,
  commands, primitives, and the folder-structure contract. Ships in versions.
- **`~/.ccs-config`** — your fleet, developed *assuming the tool is stable*: roles, hooks, rendering rules.
  Iterated while you work.
- **`~/.ccs`** — runtime **state**: what's actually being worked on; files created/updated as work happens.

Today there is **no version contract between these layers** — nothing declares "I need ccs ≥ X," nothing
stamps a config version. It works only because all three move together on one machine. Versioning them
independently (the whole point) opens three seams that can silently skew.

## Decision — the three-way contract

1. **Tool ↔ cmux:** the tool pins/guards a **cmux** version range (ADR-0054 / task #6). Out-of-range →
   loud, not a silent liveness break.

2. **Tool ↔ config, keyed on ccs semver:** a cluster package declares `requires_ccs = ">=X.Y.Z"`. On load,
   the tool refuses/warns if it's outside the range. Semver (not a separate config-schema integer) because
   most tool releases are bug fixes that DON'T change the config contract; we don't want to bump a schema
   number for those. The "config contract" (which role.toml fields / hook types / folder conventions the
   tool honors) is a documented surface tied to ccs releases.

3. **Tool ↔ state:** **state** carries a `schema_version`; ONLY the tool migrates it forward; state never
   migrates itself. (Index already drops+rebuilds as a pure cache; the catalogue migrates in place — the
   untested v1→v19 chain, P0 U2 — this makes the ownership rule explicit.)

## Decision — config is versioned PER CLUSTER, with a changelog

A cluster is already a self-contained package (ADR-0048), so the version lives **per cluster**, not on the
whole `~/.ccs-config` dir. Two clusters may target different ccs versions during a migration.

Each cluster package carries:
- a **cluster version** (its own monotonic version, independent of ccs semver), and
- a **CHANGELOG** of behavioral entries — human-authored, agent-facing: "as of vN, control no longer does X;
  do Y instead." This is distinct from a code changelog; it is *instructions to the running agents about how
  their behavior must change.*

## Decision — agents catch up on a version bump (the new mechanism)

**The problem this solves, from real history:** an earlier pr-watch pushed behavioral updates by *manually
messaging every agent* "go read the changelog." Manual, lossy, easily missed.

**The mechanism:** make it a deterministic **start action** (mirrors `drain-inbox`):

- Each **identity** stamps its **last-seen cluster version** in its runtime **state** (`~/.ccs`).
- On SessionStart (startup OR resume), a `catch-up` start action compares the cluster's current version
  (from the config package) against the identity's last-seen stamp.
- If the cluster version is **ahead**, it reads the CHANGELOG entries *between* last-seen and current and
  **injects them as additionalContext** — so the agent's very next turn is aware "behavior changed: here's
  what and how." Then it advances the identity's stamp to current.
- If equal, it's a no-op (silent). No content is lost: the stamp only advances after the entries are
  surfaced, so a killed session re-surfaces them next start (idempotent, same contract as move-on-drain).

**Determinism boundary (important):** the *detection and surfacing* are deterministic and mechanical (stamp
compare → read entries between → inject → advance stamp). The *behavioral adaptation* is inference — the
agent reads the entries and adjusts. To keep that bounded, CHANGELOG entries must be written prescriptively
("stop calling `ccs foo`; call `ccs bar`"), not vaguely. The hook guarantees the agent SEES the change on
its next turn; the entry's clarity determines how reliably it ACTS. This is the honest split: ccs makes
noticing deterministic; the changelog author makes acting reliable.

## Consequences

- **Config package gains:** a version field + `requires_ccs` + a `CHANGELOG` (structured entries keyed by
  cluster version). Per cluster.
- **State gains:** a per-identity `last_seen_cluster_version` (a **state doc** field, `mergeFields`,
  single-writer = the catch-up action).
- **New start action `catch-up`** in the `start` hook type, ordered after `arm`/`drain-inbox`. Pure
  mechanics; injects changelog deltas; advances the stamp only after surfacing.
- **New tool responsibilities:** parse `requires_ccs` on cluster load and gate; expose the cluster version +
  changelog to the catch-up action; own state `schema_version` migration.
- **Ties the loop together:** a fleet keeps rolling across a config bump WITHOUT a human messaging every
  agent — the bump is noticed, the delta is read, behavior adapts, the stamp advances. It's the
  self-healing analog of the sensed-state model (ADR-0031): behavior version is sensed from the config +
  the stamp, not remembered by the agent.
- **Interacts with worker lineage:** a fresh **embodiment** (ADR-0038) starts with no stamp → sees the full
  relevant changelog window (or from its work-unit's creation version), so a just-spawned worker isn't
  behind. Exact starting point (all vs since-work-unit-created) is an implementation detail to settle.
- **Open:** whether `requires_ccs` mismatch is a hard refuse or a warn-and-run (probably: refuse on major
  gap, warn on minor) — settle when implementing.
