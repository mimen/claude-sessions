# Tab paint is a pure function of the row, fired by both the turn hook and a selector-driven sweep

Decided with Milad 2026-07-11 while reviewing the system-unit decomposition. Firms up the shape of
`sync-tabs` (unit S17) and aligns its command surface with the resume family. Builds on ADR-0027
(surface-keyed tab ownership), ADR-0040 (paint by surface UUID), ADR-0042/0054 (spawn/liveness), and the
selector collapse that produced `ccs resume <selector>`.

## The question

Should `sync-tabs` still exist, and if so, what's its command shape? Milad's instinct: the singular should
be the primitive and the plural should be a loop over it — mirroring how `ccs resume-cluster` is a fan-out
over `resume-session`.

## Why the sweep must exist (it is load-bearing, not redundant)

A **tab** is rendered from a session's **CatalogueRow** (title/description/color/pill — S16). Two things
fire that render:

1. **The per-turn path** — every session's own **Stop** hook repaints its tab, plus eager-paint on
   **resume** (S17 inside S23). This covers "paint my tab when *I* take a turn."
2. **The sweep** — `sync-tabs --all` repaints every live session from current catalogue state.

The sweep is NOT covered by (1), because a session's row is routinely mutated **by another actor while that
session is idle**: **control** **marks** a PR merged, **concierge** writes a **statusLine**, the engine
**senses** a **stage** change. Those writes never trigger the idle worker's Stop hook, so its tab would go
stale until it next runs. The sweep is the only thing that catches cross-actor freshness.

## Why a sweep, not paint-on-write

Painting at the mutation site is tempting but wrong here, for reasons that are structural, not incidental:

- **Process + auth boundary.** Mutations happen in contexts that cannot reach the cmux socket — the engine
  is Python and not cmux-authed; CLI mutation contexts may not be either. Painting MUST run from a
  cmux-authed context. Decoupling paint from mutation is forced by the substrate (same gate as ADR-0054).
- **The liveness race.** Event-driven paint reintroduces the "paint before the surface exists" race that
  the `refOverride` hack exists to dodge (a just-spawned **workspace** isn't yet bound in the **hook
  store**). A periodic, idempotent sweep sidesteps it.
- **Determinism.** Paint is a *pure function of the row*. Running it on a cadence is self-healing: whatever
  the row says now is what the tab shows within one tick. A missed event can never leave a tab permanently
  wrong. The cost — a tab can lag up to one sense/sync tick — is acceptable.

So the sweep stays.

## Decision

1. **Paint is a pure function of the row, with two triggers, one implementation.** The single-session paint
   primitive (`pushRenderOps(sessionId)`, S17) is the only place that renders + pushes to cmux. The Stop
   hook (per-turn) and the sweep (cross-actor) are just two callers of it. No second paint path.

2. **Collapse the command to one selector-driven verb**, not a singular/plural pair. `ccs sync-tabs <sel>`
   resolves the selector to a set of **sessionId**s and loops the single-paint primitive over them:
   - `ccs sync-tabs .` — paint the current session (the singular primitive).
   - `ccs sync-tabs <id>` — paint one.
   - `ccs sync-tabs --all` / `--cluster pr-watch` / `--role pr-agent` — fan out.

   This is the exact shape the resume family already settled on (`ccs resume <selector>`), and it **reuses
   the same selector-resolution unit (S18)** — one target-parser shared across resume and paint, not two.
   We deliberately reject `ccs sync-tab` (singular) + `ccs sync-tabs` (plural): two commands differing by
   one `s` is a typo footgun. `resume-session`/`resume-cluster` avoid that because they're distinct words;
   `sync-tab`/`sync-tabs` do not.

3. **The sweep always skips retired tabs** (completed/archived), unchanged (ADR-0040 stale-mapping guard).

4. **Optional rename (Milad's call, not required by this ADR):** the underlying **hook type** is already
   `cmux-paint` and the primitive is `pushRenderOps` — nothing is being "synced," a tab is being *rendered*
   from the row. `ccs paint <selector>` reads more honestly than `sync-tabs`. Recorded as an option; not
   done here to avoid churn.

## Consequences

- Command surface: fold the current `sync-tabs [<id>|.|--all]` into `sync-tabs <selector>` backed by S18.
  The `--all` behavior is preserved; `--cluster`/`--role` targeting comes for free from the shared selector.
- No behavioral change to painting itself — S16/S17 are untouched; this is a surface + composition cleanup
  that makes the "plural is a loop over the singular" structure explicit, matching resume.
- Reinforces the vocabulary: "target a set of sessions by selector" is now one concept (S18) used by both
  resume and paint, one more place the shared language removes a duplicate parser.
- Feeds the CLI-ergonomics cleanup (the audit already flagged `sync-tabs` help/behavior drift); this ADR is
  the intended end state to implement against.
