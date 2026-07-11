# Lifecycle is control-driven; workers self-report; and a worker is born correct or not at all

Follows ADR-0010 (completion policy) + ADR-0032 (one responsibility, one embodiment). Decided
with Milad 2026-07-10. Design doc: `docs/hook-instantiation-pr-watch.html` §00b + §07.

## Part 1 — who moves a session's status

A worker does NOT mark itself merged / completed / archived, and shouldn't: a session can't
reliably observe its own PR's merge or prod-deploy, and a dead/hung session would never fire.
Lifecycle is **control-driven off sensed facts** (already how pr-watch works, ADR-0010):

| Transition | Who | Trigger | Mechanism |
|------------|-----|---------|-----------|
| `phase` (building→review→ready→merged…) | both | worker's `stop` self-reports its turn-end phase (belt); control's board/gate sensors set the authoritative phase (suspenders) | `ccs phase <sid>` |
| `completed` (retire from fleet) | control | merged AND prod-shipped AND confirmed-live (ADR-0010), over sensed facts | `ccs mark --completed` |
| abandoned / won't-do | control (on Milad's call, relayed by concierge) | PR closed-unmerged, or Milad drops it | `ccs mark --archived` |
| `parked` | control | blocked / awaiting Milad | `ccs mark --parked` |

**Principle: ccs owns the lifecycle MECHANISM (`ccs mark`); the cluster owns the POLICY (when).**
A worker reports what it KNOWS (its turn-end phase, its result) via its `stop` hook; the actor
tier (control) decides LIFECYCLE from cross-cutting sensed facts a single session can't see. A
worker self-completing would be a session asserting a fact (my PR shipped to prod) it has no
authority to observe. What a worker must UNDERSTAND (not do) is injected via the layered
`claude-md` (ADR-0043/0044): its identity is durable, control drives lifecycle, it reports
honestly, the gate governs review, push≠post.

## Part 2 — the worker spawn contract (born correct or not at all)

A `pr-agent` is only useful if created in the right worktree, bound to the right work-unit, with
the right permissions, from turn one. `new-session` VALIDATES or REFUSES — a worker cannot come
into existence mis-wired (the same discipline as ADR-0042).

1. **Worktree created + verified first** — spawn creates the git worktree; `new-session --cwd
   <worktree>` validates the dir exists (`validateSpawn`) and refuses otherwise.
2. **Correct-worktree check** — `spawn-location` (ADR-0046) resolves THIS work-unit's worktree
   (not a shared dir); verify its checked-out branch matches the PR/work-unit.
3. **Identity + facts stamped atomically at birth** — `new-session` writes role/system/
   `--pr-number/--pr-repo/--gus-work` + the worktree path onto the row before claude launches on
   that id. Self-identified from turn one; no sync-notice wait, no cwd/title guess.
4. **One embodiment per responsibility** (ADR-0032) — refuse to spawn if a live worker already
   owns this work-unit's worktree; reuse it instead.
5. **Permissions by grant, not injected file** — the worktree is granted via
   `additionalDirectories` from the role's materialized settings (ADR-0036), nothing written
   into the tree.
6. **Context on first turn** — the `start` hook drains the inbox; the `claude-md` hook injects
   the layered brief. It wakes knowing the PR, the gate, the epic gotchas, its lane.

**Invariant: spawn is fail-closed.** Missing worktree, wrong branch, or an already-live
embodiment → `new-session` errors rather than launching a mis-wired worker. A worker that exists
is a worker that's correct.

## Consequences

- `stop` (worker self-report) sets phase only, never lifecycle; control's completion/board
  sensors own `ccs mark`.
- `new-session` gains the branch-match + one-embodiment checks (fail-closed), on top of the
  existing cwd-exists validation.
- The concierge→control relay (ADR: cluster roster) is how a Milad "drop this PR" decision
  reaches control to `ccs mark --archived`.
