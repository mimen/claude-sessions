# Hook merge is a typed property of the hook type — policy floor vs. context hint

Follows ADR-0043 (ccs resolves layered hook config). Decided with Milad 2026-07-10 after a
cross-model review flagged that two flat strategies ("additive" / "most-specific-wins") aren't
enough. Design doc: `docs/hook-resolution-draft.html` §05.

## The problem two flat strategies hit

`claude-md` is mostly additive — but a role sometimes needs to SUPPRESS or REPLACE an inherited
instruction, not just add. Example: `eval` says "ignore the normal PR flow; you grade from
outside," while the cluster constitution's PR-flow rules stay equally active — the composed
prompt contradicts itself. A single flat strategy can't express "add, but also let a lower
level retract some inherited guidance while keeping the invariants."

## Decision — each type declares a STRUCTURED merge; strategy is per-type and static

The combination strategy is a property of the hook TYPE (declared once in a hook-type
registry), never chosen per level or per file. The resolver returns the ordered layers; a
per-type combinator applies the declared merge, keeping the effective result a pure function of
(row + config tree).

| Type | Merge rule |
|------|------------|
| `claude-md` | **ordered sections by id**; each level may `append` / `replace` / `suppress` a section — EXCEPT sections marked `floor:true`, which can only be appended to |
| `meta-update` | **set-union** of field names down the chain (it's a set, not an object — shallow object-merge is wrong) |
| `start` / `stop` | **ordered action list**; levels append; each action has an explicit ordering key and must be idempotent |
| `guard` | **union with deny-wins** conflict policy (future) |
| `cmux-paint` · `statusline` · `spawn-location` | **most-specific-wins** (single owner; nearest defined level owns it whole, broader levels are fallback) |

## The underlying distinction — policy floor vs. context hint

Some inherited content is a **non-removable invariant** (the cluster's `push ≠ post`, the gate,
the ccs identity contract) — a lower level may add to it but never suppress it: `floor:true`.
Other content is **replaceable guidance** (a role's "focus on X") — a lower level may override
or suppress it: a hint. A type's merge rule encodes which of its content is floor and which is
hint. This is what lets a worker be told "ignore the normal flow" (suppress a hint) while still
being unable to drop `push ≠ post` (a floor).

## Scope — build structured merge only where demonstrated

Ship the structured merge where it's actually needed: `claude-md` sections and `meta-update`
set-union. For `start`/`stop`, ship simple ordered-append first; add richer ordering only when a
real ordering bug appears (don't pre-build a workflow engine).

## Open (tracked, not blocking)

The `claude-md` **section-id vocabulary** needs fixing: a stable set of ids (e.g. `identity`,
`constitution`, `gate`, `voice`, `roster`, `epic-notes`, `role-brief`) and which are
`floor:true`. The cluster roster + `push≠post` + gate + identity contract are floor; epic notes
+ role brief are hints.

## Consequences

- The hook-type registry gains a `merge` field per type (structured, not a flat enum).
- `claude-md.md` files are section-structured (headings as ids), not free prose, so
  append/replace/suppress can target sections.
- A single shared combinator per merge-kind keeps resolution testable in isolation.
