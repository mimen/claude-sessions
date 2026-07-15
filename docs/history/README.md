# History — design docs, plans, presentations

Point-in-time **design artifacts** — the plans, scoping docs, and presentations
that shaped where ccs and its clusters are today. Not living documentation; not
audit findings. These are what we wrote *to think*: to align on a direction, to
propose a refactor, to explain the system to a new audience.

They live here so:
- Someone new to the project can read them chronologically and understand how
  we got where we are.
- Someone revisiting a decision has the reasoning captured, not just the outcome.
- The transient Desktop/Downloads copies stop being the only record.

For point-in-time **audits and reviews** (findings from a reviewer, checklists,
readiness scores) see `../audits/`. For the current, living design record see
the ADRs in `../adr/`.

If you're producing a new plan/presentation, drop it here with a date suffix
(`<slug>-<yyyy-mm-dd>.html`).

## Contents

- `ccs-full-system-review-2026-07-14.html` — the original planning doc for the
  2026-07-14 hardening arc. Drove Phase 1 (D1-D8, B2/B11/B12/B14/B15) + Phase 2
  (shareability: sanitize, .env overlay, LaunchAgent installer, cluster wizard,
  doc cleanup) + the CLI audit that seeded the noun-grouping reorg.
- `ccs-identity-refactor-2026-07-14.html` — scoping doc for the identity
  refactor (ADR-0089). Three-tier model, per-role tables, full CLI reorg, the
  pr-watch reimagining. The ADR is the durable record; this is the source
  material that fed it.
- `pr-watch-architecture-2026-07-14.html` — presentation deck ("ccs × pr-watch
  — the vision"). Used for the 2026-07-14 pr-watch presentation.
