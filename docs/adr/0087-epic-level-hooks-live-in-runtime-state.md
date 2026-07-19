# ADR-0087: Epic-level hooks live in runtime state, not the config repo

Status: **active** (adopted 2026-07-14, shareability follow-up to ADR-0043)

## Context

The layered-hook resolver (`src/hooks/resolve-levels.ts`) walks six levels for a session:
`user → cluster → role → epic → work-unit → identity`. Five of them are clearly shareable
config (roles, cluster manifests, work-unit hooks templated per anchor type) or clearly
runtime state (identity — the per-agent inbox + state that never leaves the machine).

The **epic level** was placed under the config repo:
`<configRoot>/clusters/<cluster>/epics/<groupingId>/.ccs-hooks/`. In principle this was
consistent with the other definitional levels. In practice, the actual content that
accumulated in these directories was per-work runtime data:

- "CX/Helen copy review is deferred to one end-of-epic ticket (W-XXXXXXXX)"
- "Don't file a per-PR CX ticket; the epic owns that"
- Specific reviewer routing tied to specific ADM_Work__c record IDs

Two problems this created:

1. **Sharing the cluster shape leaks per-user work state.** Publishing the config repo to
   teammates ships my epic-specific context. Another user working on a different epic
   inherits my defer decisions, my ticket references, my reviewer routing.
2. **The Salesforce record IDs are per-user opaque tokens.** `a3QEE000002Hbej2AC` isn't
   meaningfully "shape" — it's my org's specific grouping identifiers.

Discovered during the 2026-07-14 v2 production-readiness review as the substantive design
issue behind the sanitization concern: it's not that the config has "too much detail" — a
*level* was put on the wrong side of the config/runtime boundary.

## Decision

**The epic level's hook dir moves from the config root to the runtime root.**

Concretely: `resolveLevels` computes the epic-level dir under `ctx.runtimeRoot`, not
`ctx.configRoot`:

```typescript
// Before
{ level: "epic", dir: join(ctx.configRoot, "clusters", seg(cluster), "epics", seg(groupingId)) }

// After
{ level: "epic", dir: join(ctx.runtimeRoot, "clusters", seg(cluster), "epics", seg(groupingId)) }
```

Same layout, different base. No other resolver logic changes.

Existing epic hook content in `~/.ccs-config/clusters/pr-watch/epics/` is copied to
`~/.ccs/clusters/pr-watch/epics/` and removed from the config repo. Since epic hook
resolution is level-based (not searched), the caller-side change is exactly one line.

## Consequences

**What this fixes:**
- The config repo is now free of per-user work state at the epic level.
- Teammates cloning the public config repo don't inherit my epic-specific defer decisions,
  ticket references, or reviewer routing.
- The distinction "config = shape, runtime = state" gets a cleaner mental model: **every
  level that carries WORK content lives in runtime**; every level that carries SHAPE
  lives in config.

**What this preserves:**
- Cluster-level, role-level, user-level, work-unit-level hooks all remain in the config
  repo (shape).
- Identity-level hooks were already in runtime state.
- The resolver's ordering, merge strategy, and precedence rules are unchanged.

**Migration:**
- One-time copy: existing epic hook dirs from config → runtime. Committed removal from
  the config repo. Existing pr-watch epics keep their behavior (same content, different
  base).
- Future authors of epic-level hooks target `~/.ccs/clusters/<c>/epics/<id>/.ccs-hooks/`
  directly — never checked into git.

## Related

- ADR-0043 (layered hook resolution) — this ADR narrows one level's base.
- ADR-0025 (state homes: config = shape, runtime = state, tool = generic) — this ADR is a
  correction that re-anchors the epic level on the right home.
- 2026-07-14 production-readiness review v2 — where the design issue was surfaced.
