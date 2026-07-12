# The work-unit is a first-class entity with a stable id; PR / GUS / cwd are attributes, not its identity

Decided with Milad 2026-07-11, reasoning up from "why are work-unit keys readable, and could they just be
ids?" This is a keystone identity change. It supersedes the derived-string **work-unit** key
(`spawn-contract.ts` `spawnWorkUnit`/`rowWorkUnit` + its 5 copies) and reframes the P0 U4/S2 "6 copies"
finding: the copies existed because the concept had no home. It generalizes ADR-0032 (one-embodiment) and
ADR-0038 (lineage) so they no longer depend on a PR/GUS-shaped string. Same structural move as ADR-0051
(grouping became an entity a session references by FK).

## The question we started from

Work-unit keys are human-readable strings (`pr:repo#123`, `gus:W-456`). Milad asked: what does readability
buy, and could they just be ids? — motivated by a real case: **we often kick off a worker before there is
any PR or GUS ticket.** We're just starting some work.

## What we found

- **Readability itself buys almost nothing** — one CLI convenience (`ccs resume #123`) and one eyeball
  convenience. Not architectural.
- **The real value of the string was *derivability*:** any process that knows "this is PR 123" computes the
  *same* key with no shared state. That is what powers the two behaviors we actually care about:
  1. **one-embodiment dedup** — two independent spawns for PR 123 compute the same key, collide, second is
     refused (ADR-0032);
  2. **lineage** — a *fresh* session (not a resume) for PR 123 computes the same key and finds its
     predecessors (ADR-0038).
- **But derivability hardcodes PR-then-GUS as the only two shapes.** A fleet role with no PR/GUS (Milad's
  "just kicking off work") gets `null` from `spawnWorkUnit()` → the spawn contract is a **no-op for it** →
  **no dedup at all**. And the current fallback tier `sid:<sessionId>` deliberately gives no dedup and no
  cross-session lineage (a session id can't be re-derived by a second session).
- **A plain increasing numeric id does NOT simplify** — it *defeats* the two behaviors: spawn for PR 123
  today → id 47; dead; fresh spawn tomorrow → id 48; now two "work-units" for one PR, dedup gone, lineage
  severed. "Increasing" also needs a central counter (a concurrency/determinism hazard).

## The decision Milad made (both answers)

1. **Do two SEPARATE sessions need to recognize they're the same work? YES.** (The 12120/12121
   duplicate-fleet bug was exactly two sessions clobbering one PR.) So identity cannot be pure per-spawn
   allocation — it must be *find-or-create*, not *always-create*.

2. **Make the work-unit a FIRST-CLASS ENTITY with its own stable id, created when work starts; PR / GUS /
   cwd / branch attach to it as ATTRIBUTES, not as its identity.**

## Design

**The work-unit entity** (lives in **cluster state**, like **grouping** — ADR-0051):
```
work-unit {
  id: string          # stable, ccs-minted at creation (opaque; e.g. wu_<short>). THE identity.
  cluster: string
  # attributes — any/all may be absent at creation, attached later:
  prRepo, prNumber, prState, prHeadSha : ...   # attached when the PR exists
  gusWork                              : ...   # attached when the ticket exists
  title / label                        : ...   # human handle
  createdAt, updatedAt, source
}
```

**A session references its work-unit by FK** — `CatalogueRow.workUnitId` (mirrors `epicId`). The row STILL
carries `prNumber`/`prRepo`/`gusWork` as denormalized sensing targets (the engine stamps them), but they
are no longer the *identity* — they're how the work-unit's attributes get populated.

**Identity is find-or-create, keyed on the id, reconnected via attributes:**
- Kick off work with no anchor → mint a work-unit id, session FKs to it. Dedup + lineage key on the **id**.
- The work later gets a PR → the PR attaches to the *existing* work-unit (attribute update); identity
  doesn't change.
- A second/fresh session for the same real work → **resolves to the same work-unit id** by looking up the
  anchor attribute ("which work-unit has prNumber=123?") — find-or-create, not re-derive-the-string.
- `ccs resume #123` / a **selector** resolves `#123` → work-unit id (attribute lookup) → its sessions.

**This subsumes the derived key.** `pr:repo#123` stops being an identity and becomes at most a display
label. The 6 hardcoded PR-then-GUS computations collapse into ONE place: mint-or-resolve a work-unit.
`sid:` fallback disappears (a no-anchor work-unit just has an id and no attributes yet — which is the
*normal* creation state now, not a degenerate fallback).

**Ties to ADR-0057-adjacent role work (open, see Consequences):** whether a role is fleet (needs a
work-unit) or core (never has one) should become a declared role property, and the *anchor type* a work-unit
uses (pr / gus / freeform) should be declarable too — so a new fleet type isn't blocked on ccs code. That is
a separate ADR; this one establishes the entity. Recorded here so the two aren't conflated: **this ADR =
work-unit is an entity; the follow-up = roles declare fleet-ness + anchor type.**

## Consequences

- **New entity + store:** a work-unit store in cluster state (`~/.ccs/clusters/<c>/cluster/work-units.json`
  or similar), with get / find-by-attribute / mint / attach-attribute ops — modeled on `state/groupings.ts`.
- **Schema:** add `work_unit_id` to CatalogueRow (additive migration, next version). `prNumber`/`prRepo`/
  `gusWork` stay as sensed attributes; `phase`-style deprecation not needed.
- **one-embodiment (S19) + supersede-dedup (S22)** re-key from the derived string to `workUnitId` — same
  logic, stable input. This is the correct fix for the U4/S2 "6 drifted copies" P0 item: don't just
  centralize the PR/GUS string, retire it.
- **Hook levels (S14/`resolve-levels.ts`):** the "work-unit" **level** dir keys on `workUnitId` (an opaque
  segment) instead of the `pr:repo#123` / drifted `repo-123` string — which also fixes the inbox-path drift
  (the identity dir and the dedup key finally agree, because both are the id).
- **Cost of the decoupling (accepted):** re-spawning for the same real work now means *reconnecting to the
  work-unit id* (find-or-create by anchor) rather than getting continuity for free from string derivation.
  That reconnection lookup is essentially the one-embodiment check we already run, phrased against the
  work-unit store.
- **Reconnection needs at least one anchor OR an explicit id.** Two truly anchorless fresh sessions can't
  auto-recognize each other (nothing to match on) — by design; if you want them to share a work-unit, pass
  the id. This is strictly better than today (`sid:` never reconnects at all).
- **Migration:** backfill — for existing rows, mint a work-unit per distinct current derived key
  (`pr:...`/`gus:...`), set `work_unit_id`; rows that only had `sid:` get a fresh per-session work-unit.
- **Selector (S18) + resume:** `#pr` / `W-id` resolve through the work-unit's attributes; add a work-unit id
  as a first-class selector token.
