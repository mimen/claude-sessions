# A role declares its work-unit anchor type; fleet-ness follows from it

Decided with Milad 2026-07-11. The follow-up ADR-0057 deferred: how a role says *what shape of work-unit it
owns*, so a fleet type beyond PR/GUS is possible without a tool change. Builds on ADR-0057 (work-unit is a
first-class entity), ADR-0062 (role declares its properties), ADR-0061 (generic mechanism / cluster
vocabulary). Sibling of ADR-0070 (grouping types) — same pattern, kept separate per Milad.

## The problem

ADR-0057 made the **work-unit** a first-class entity with attributes; but *which* attribute anchors a given
role's work-unit is still hardcoded (PR wins, else GUS) in the tool. So:
- a fleet role with a non-PR/GUS anchor (a Slack channel, a customer account, a freeform task) has no way to
  say so, and gets no **one-embodiment** protection (its anchor computes to null);
- **fleet-ness itself** is still a hardcoded `topology` guess (ADR-0062 interim) rather than something that
  falls out of "does this role own a work-unit?".

## Decision

**A role declares its work-unit anchor type in `role.toml`; the tool uses it to mint/resolve work-units;
fleet-ness is derived from it.**

```toml
work_unit = "pr"        # this role's work-unit is anchored by a PR (repo + number)
# work_unit = "gus"     # anchored by a GUS W-number
# work_unit = "freeform"# ccs-minted id only, no external anchor (the "just kicking off work" case)
# work_unit = "none"    # this role owns no work-unit → it is a CORE role
```

1. **The anchor type names which attribute reconnects a work-unit** (ADR-0057 find-or-create): `pr` →
   resolve/dedup by `prRepo#prNumber`; `gus` → by `W-id`; `freeform` → by the ccs-minted id only (no
   auto-reconnect across separate sessions — you pass the id); `none` → no work-unit.

2. **Fleet-ness is derived, not separately declared.** `work_unit = "none"` ⇒ **core**; anything else ⇒
   **fleet**. This *replaces* the interim `topology` field from ADR-0062 — one declaration
   (`work_unit`) now yields both "what anchors my work-unit" and "am I core or fleet." (If a role ever needs
   to be fleet-shaped-but-anchorless it's `freeform`; core is precisely "no work-unit.")

3. **The tool ships the anchor types it knows** (`pr`, `gus`, `freeform`, `none`) as built-ins. A cluster
   wanting a genuinely new anchor shape (e.g. `slack-channel` with its own reconnect key) is the extension
   point — but per ADR-0061, that's a declared cluster vocabulary, not a tool change for the common cases.
   (A full cluster-defined-anchor registry is possible later; the four built-ins cover current + the
   freeform escape hatch, so we don't over-build.)

## Consequences

- `role.toml` gains `work_unit`; **remove the interim `topology`** field (ADR-0062) — `isCoreRole` becomes
  `work_unit == "none"`. The hardcoded `CORE_ROLES` set stays deleted (0062); its replacement is now this,
  not `topology`.
- The work-unit mint/resolve logic (ADR-0057) dispatches on the role's anchor type instead of hardcoding
  PR-then-GUS. The canonical work-unit resolver reads `work_unit` to know which attribute to key on.
- pr-agent declares `work_unit = "pr"`; the core roles declare `work_unit = "none"`; a future exploratory
  worker uses `freeform`.
- Hook **work-unit level** (resolve-levels) and one-embodiment key on the work-unit id regardless of anchor
  type (ADR-0057) — anchor type only affects *reconnection*, not the key.
- Update ADR-0062's role-properties block: `work_unit` subsumes `topology`. Glossary: **core/fleet** derived
  from `work_unit`; **anchor type** is a role-declared property.
