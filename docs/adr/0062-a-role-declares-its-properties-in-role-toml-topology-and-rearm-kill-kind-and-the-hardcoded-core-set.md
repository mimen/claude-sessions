# A role declares its properties in role.toml (topology + re-arm); kill `kind`, the session resume_command cache, and the hardcoded CORE_ROLES set

Decided with Milad 2026-07-11. The capstone of the session's arc: it stops the platform from hardcoding or
deriving role identity and moves it into the role's own declaration. Applies ADR-0061 (generic mechanism /
cluster vocabulary) to the role itself, finishes the job ADR-0053 started (kind as role property), and is
the role-properties dependency that ADR-0057 (fleet-ness / work-unit anchor) and ADR-0060 (which fields a
role uses) were waiting on. Files-are-truth (ADR-0050): `role.toml` is the source.

## The problem

Role identity is currently split across three bad homes:
- **`resume_command`** lives on BOTH the role (`role.toml`) AND every session (a copied catalogue column);
  resume reads the session copy → the role's authored value and the session's cache can drift.
- **`kind` (loop/session)** is authored on the role, cached on the session, AND branched on by the platform
  renderer (loop → Purple color + loop pill). But across all 6 roles `kind == "loop"` iff `resume_command`
  is present — it's derivable, and its only real consumer is *presentation*, which per ADR-0061 isn't the
  platform's to decide.
- **core-vs-fleet** is a **hardcoded `Set` of role-name strings in the ccs binary** (`cluster-map.ts:41`
  `CORE_ROLES`). A new core role isn't recognized until someone edits ccs source and ships a release — the
  exact "adding a role needs a tool change" friction.

All three are the same smell: the platform hardcodes/derives what a role *is*, instead of the role
declaring it.

## Decision

**A role declares its properties in `role.toml`. The platform reads them; it does not hardcode or cache
them.**

1. **`resume_command` is role-only. Delete the session cache.** Drop the `resume_command` catalogue column.
   Resume looks it up from the session's `role` → `role.toml` (the session row already carries `role`, so
   this is a lookup, not new plumbing). **A session always re-arms from its role** — the per-session
   `--resume-command` override is retired (no current role uses it; one source of truth is worth more than
   the escape hatch). A config edit now propagates to how a session re-arms; ADR-0058 catch-up is the
   deliberate channel for that, not a silent divergence.

2. **Kill `kind` everywhere.** No catalogue column, no `role.toml` field, no renderer branch, no `--loops`
   read. "Does it re-arm?" is derived where needed as `resume_command != null` **on the role** — computed,
   never stored. This removes the "loop role with no resume_command" invalid state entirely (it becomes
   unrepresentable). Supersedes the ADR-0053 "kind is a cached role property" compromise: it's not cached at
   all now, it's gone.

3. **Core-vs-fleet is a declared role property in `role.toml`.** Replace the hardcoded `CORE_ROLES` set:
   `role.toml` declares the role's topology (e.g. `topology = "core"` | `"fleet"`, exact key TBD in impl —
   could also be inferred as "fleet iff it has a work-unit anchor type," per ADR-0057). `isCoreRole()` reads
   the declaration. A new cluster's roles classify themselves with **zero tool changes** — the ADR-0061 goal
   made real for roles.

4. **Rendering stops branching on kind; the loop-status pill moves to cluster render rules.** The platform
   renderer no longer picks a "loop template" (Purple color was incidental — dropped). The genuinely-useful
   loop-status pill (control health / concierge queue / eval grade, sensed by `loop_status.py`) is a
   **pr-watch cluster feature** and moves into pr-watch's render rules (ADR-0060/0061), keyed on the
   declared **topology** (or on the sensed status field directly), not on a platform `kind` enum.

## What role.toml carries after this (the role's declared properties)

```toml
# authored role identity — the source of truth (ADR-0050)
topology       = "core" | "fleet"     # replaces the hardcoded CORE_ROLES set (§3)
resume_command = "/loop 15m /..."      # present ⇒ re-arms (this IS the old `kind`, §1/§2)
# (+ future, per the other ADRs:)
# work_unit      = "pr" | "gus" | "none"   # anchor type — fleet roles (ADR-0057 follow-up)
# meta_keys      = [...]                    # which meta keys this role uses (ADR-0060)
```
Everything else about a role stays DERIVED from the directory (skills/commands/hooks — ADR-0050). `kind` is
gone; core-vs-fleet and re-arm are the two authored behavioral properties.

## Consequences

- **Schema (tool-owned migration, ADR-0058):** drop the `resume_command` and `kind` catalogue columns.
  Sessions keep `role`; resume + any kind-ish check resolve through `role.toml`.
- **`role.toml`:** add `topology`; `resume_command` stays (now the sole home). Loaders (`role-files.ts`)
  surface `topology`; `RoleDef` gains it, drops the need to treat `kind` as separate from resume_command.
- **`isCoreRole`:** reads `role.toml` topology (via the role registry) instead of the hardcoded `CORE_ROLES`
  set; the set + `CORE_ORDER` legacy lists are deleted (ordering can stay as a display preference, but
  membership is declared).
- **resume path:** `resume-session.ts` resolves `resume_command` from the role, not `cat?.resumeCommand`.
  `--resume-command` flag removed from `new-session`.
- **renderer:** `render-tab.ts` stops the `kind === "loop"` branch and the Purple default; pr-watch's loop
  pill logic relocates to cluster render rules. `--loops` filter (cli.ts:320) keys on topology instead.
- **CHANGELOG (ADR-0058):** `--resume-command` gone; `kind`/`ccs mark --loop` semantics gone; behavior
  authored in `role.toml` now — prescriptive entries so running agents/config authors adapt.
- **Unblocks the follow-ons:** ADR-0057's "roles declare fleet-ness + anchor type" and ADR-0060's "roles
  declare which meta keys they use" now have a home — they're more keys in the same `role.toml` properties
  block this ADR establishes.
- **Glossary/units:** remove **kind** as a session/stored concept (it's derived, and mostly just gone);
  redefine **core/fleet** as a declared **role** property; note **resume_command** is role-authored, no
  session copy, always re-armed from the role.
