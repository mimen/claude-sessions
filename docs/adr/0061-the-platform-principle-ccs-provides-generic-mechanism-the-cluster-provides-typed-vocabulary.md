# The platform principle: ccs provides generic mechanism; the cluster provides typed vocabulary

Named with Milad 2026-07-11 after the same pattern surfaced three times in one design session. This is a
meta-ADR: it doesn't decide a single feature — it states the principle the recent concrete ADRs (0057,
0059, 0060) all instantiate, so future design defaults to it. Grounded in the three homes (ADR-0041) and
the tool↔config↔state versioning contract (ADR-0058).

## The principle

**ccs (the tool) provides generic mechanism, storage, and behavioral guarantees. The cluster config
provides the typed vocabulary and semantics. Neither reaches into the other.**

Concretely, for any concept that varies by cluster:
- **ccs owns:** the generic entity/field/primitive; how it's stored, stamped, indexed, and returned; and any
  *behavioral guarantee* worth enforcing platform-wide (atomicity, single-writer, fail-closed, monotonicity
  when opted in). ccs does NOT interpret the cluster's meaning.
- **the cluster owns:** the vocabulary (what the values are), the semantics (what they mean, the state
  machine, the transitions), and the rendering rules (how values become a **pill**/**tab**). The cluster
  does NOT need a tool change to add a value, a field, or a rule.

The test for where something belongs: **would a second, unrelated cluster inherit it?** If a hypothetical
`event-watch` cluster would be saddled with a field/column/command/enum that only means something to
pr-watch, that thing is in the wrong layer — it belongs in cluster config, behind a generic ccs mechanism.
(Note the *right* driver is this inheritance test, NOT "avoid migrations" — migration churn is cheap and a
bad reason to reach for generic storage.)

## The three instances that revealed it

1. **work-unit (ADR-0057)** — ccs provides a generic **work-unit** entity with a stable id + a metadata
   map; PR/GUS/cwd are *typed attributes* a cluster attaches. ccs guarantees one-embodiment + lineage on the
   id; it doesn't know what a "PR" is.
2. **grouping (ADR-0059)** — ccs provides a generic **grouping** a session references by FK; the *type*
   (pr-watch's is `epic`) is the cluster's. ccs stores the reference; it doesn't know what an "epic" is.
3. **session metadata (ADR-0060)** — ccs provides blessed **stage**/**activity** string columns (display +
   the monotonic/transient shapes) plus a generic **meta** map; the cluster defines the state machine and
   what lives in the map (miladReview, buildComplete, …). ccs stores + renders via cluster rules; it doesn't
   know what "milad-review" means.

Same shape every time: **generic mechanism + behavioral guarantee in the tool; typed vocabulary + semantics
in the cluster.**

## Why this is the north star for shipping ccs

The goal (Milad's framing, ADR-0058): ship ccs as a stable, versioned tool; develop a fleet in
`.ccs-config` *against* it; keep a running `.ccs` deployment rolling across upgrades. That only works if the
tool doesn't need to change every time a fleet needs a new field, value, verb, or workflow. This principle
is precisely what keeps the tool stable while fleets iterate: **a new cluster (or a new capability in an
existing one) is a config change, not a ccs release.** It is the design rule that makes "stand up
event-watch without touching the tool" true rather than aspirational.

## Consequences / how to apply it

- **Default for new design:** when a concept varies by cluster, reach for a generic ccs primitive + a
  cluster-config vocabulary, not a new typed column/command/enum in the tool. Only bless something into the
  platform (like stage/activity) when it's genuinely near-universal AND the platform needs to display/query
  it directly.
- **Behavioral guarantees are the tool's value-add, not just storage** — the reason to put a primitive in
  ccs is often the *guarantee* (fail-closed liveness, one-embodiment, atomic single-writer, monotonic
  latch), which a cluster couldn't enforce for itself. Storage alone can live in a generic map.
- **The CLI splits the same way:** generic setters/verbs in ccs (`ccs meta`, `ccs stage`, `ccs resume
  <selector>`); cluster-specific verbs (`ccs ready`, `ccs approve`) provided by the cluster config as
  commands that call the generic ones.
- **Roles declare their participation** (the open ADR-0057 follow-up): which primitives/fields/machines a
  role uses, so the generic surface is a declared contract per role, not a free-for-all.
- **This ADR is citable** — 0057/0059/0060 reference it as their shared rationale; future ADRs should say
  "per ADR-0061" instead of re-deriving the split.
