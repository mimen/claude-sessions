# ADR-0080: Role identity is (cluster, role), not global-by-name

Status: **active** (adopted 2026-07-14, "D3" ratified decision from full-system review)

## Context

Before this ADR, `resolveRole(role)` in `src/roles/role-files.ts` scanned every cluster's `roles/`
directory and returned the FIRST match by role name. It was called unscoped from resume, new-session,
resume-cluster (pinOnResume), stage validation, sync-tabs coloring, the roleResumeCommand cache in
`db.ts`, and hook composition.

Two clusters with roles named `control`, `concierge`, `pr-agent` (which the design explicitly
anticipates — every cluster has these role archetypes) would collide: whichever cluster sorted
first alphabetically would own those names machine-wide. Concretely:

- Resuming `event-watch:control` could execute `pr-watch`'s `/pr-watch-control` loop.
- Stage validation for an event-watch pr-agent would use pr-watch's monotonic vocabulary.
- The tab paint would use the wrong role's color.

The `ensure-control.sh` watchdog compounded this: it detected the control loop's presence by
searching cmux for the literal workspace title `CONTROL PLANE` — a second cluster reusing the
title would false-positive both watchdogs.

The `src/tui/clusterView.ts` `CORE_ORDER` list carried legacy hardcoded fallbacks
(`pr-watch-control`, `pr-watch-2`, `pr-watch-eval`, `pr-watch-scout`) — dead code from an earlier
naming pass that could also misclassify a second cluster's sessions.

## Decision

**Role identity is `(cluster, role)`. All resolution paths and caches are keyed on the pair.**

Concretely:

1. **`resolveRole(role, cluster, configRoot?)`** — cluster is a new second positional argument.
   - `cluster` supplied → look ONLY in that cluster's `roles/<role>/`.
   - `cluster === null` → explicit standalone-only lookup.
   - `cluster === undefined` → LEGACY first-match scan; logs a warning if the role exists in
     more than one cluster (the collision this ADR catches).
   - Overload accepted for tests: `resolveRole(role, configRoot)` where the second arg contains
     a `/` is treated as `configRoot`, keeping backward compat with test callers.
2. **`roleResumeCommand(role, cluster)` cache in `db.ts`** — memoization key is now
   `${cluster ?? ""}␟${role}`, not the role name alone. `rowFrom()` reads the raw row's cluster
   column and passes both.
3. **Every callsite with cluster context has been updated to pass it:**
   - `resume-session.ts` (uses `cat.cluster`)
   - `resume-cluster.ts` (uses the cluster arg the function already receives)
   - `new-session.ts` (uses `opts.cluster`; note the first `resolveRole` call happens before
     `opts.cluster` gets defaulted from the role def, so it still uses the legacy path once;
     acceptable for cluster inference).
   - `catalogue/commands.ts::stage` (uses `row.cluster`).
   - `catalogue/sync-tabs.ts` (uses `row.cluster`).
4. **`ensure-control.sh`** — the tracked workspace title is `PR-WATCH CONTROL`, not the bare
   `CONTROL PLANE`. Second-cluster watchdogs use their own scoped titles.
5. **`src/tui/clusterView.ts` legacy fallbacks removed** — the `pr-watch-control`,
   `pr-watch-2`, `pr-watch-eval`, `pr-watch-scout` entries in `CORE_ORDER` were dead code and
   are dropped.

## Consequences

**What this fixes:**
- The bug B2 hard blocker for any second cluster is retired. Two clusters can now define
  roles by the same names without cross-contamination.
- The `ensure-control.sh` false-positive class (title collision across clusters) is gone.
- Cache poisoning between clusters (a cached resumeCommand for cluster A leaking into a
  lookup for cluster B) is impossible.

**What this costs:**
- One call site is caught only by the legacy path: `new-session.ts` resolves the role once
  before it knows the cluster (the cluster gets defaulted FROM the role def). The legacy path
  warns on ambiguity, so a collision is noisy — not silent. A cleaner fix requires refactoring
  new-session's opts resolution order; not in scope here.
- Test authors writing standalone catalogue rows must set BOTH `role` AND `cluster` if they
  want the derived `resumeCommand` to resolve. Three existing tests were updated to reflect
  this (they were relying on the global-first-match behavior).

**What this does not do (yet):**
- `ensure-control.sh` still uses workspace-title matching, not ccs-identity matching. Moving
  the watchdog to identity-based liveness is D4 (control heartbeat + `ccs resume` recovery),
  a separate step.
- `roles-command.ts::rm` still uses the legacy path — appropriate because a `ccs roles rm <role>`
  from a shell has no cluster context to pass.

## Verification

- Tests: all 610 pre-existing tests pass (3 test updates required to set both cluster + role
  on synthetic rows).
- The legacy path emits a `ccs: resolveRole("...") is ambiguous — found in N places` warning
  when a role is defined in multiple clusters and the caller doesn't specify one.

## Related

- Full-system review 2026-07-14, decision D3.
- ADR-0022 (role is a first-class ccs entity, organized by cluster) — this ADR completes it
  by making the "organized by cluster" part load-bearing at resolution time.
- ADR-0062 (resume_command derived from role.toml) — the cache in db.ts is the primary consumer
  of this fix.
