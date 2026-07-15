# Audits (historical snapshots)

Each file here is a **point-in-time audit** — a report from a specific reviewer (human or agent)
about the codebase's state on a specific day. They are **not living documentation**. Findings
have either been folded into ADRs, fixed in commits, or superseded by later audits.

They live here (rather than in the top-level `docs/`) so a reader searching for current guidance
isn't misled by stale claims. If a finding still needs work, it either got promoted to an issue
or reappeared in a later audit — trust the newest audit for anything unresolved, and trust the
git log + ADRs for what's actually current.

If you're triggering a new audit, name it `AUDIT-<topic>-<yyyy-mm-dd>.md` and drop it here.

## Contents

- `REVIEW-2026-07.md` — top-5 code-review findings; #1 (lossy-encoding resume) is fixed
  (commit `cfa42e0`).
- `BRIEF-outstanding-work-2026-07-11.md` — early-July status brief across ccs + pr-watch.
- `FINDINGS-cli-ergonomics.md` — CLI + config audit; input to the 2026-07-14 noun-grouping
  reorg.
- `FINDINGS-cmux-coupling.md` — ccs↔cmux 0.64 surface audit; drove the ADR-0054 fail-closed
  guard.
- `FINDINGS-dead-code-boundaries.md` — 102-file production-readiness audit; several items
  became ADR-0068's mutation-boundary test.
- `FINDINGS-designer-transcript.md` — mined insights from the prior designer's 45MB
  transcript.
- `FINDINGS-dry-determinism.md` — 6-implementation work-unit key duplication audit; drove
  the single-derivation `deriveKey()` fix.
- `FINDINGS-hooks.md` — hook-system audit; lint status "OK" at capture.
- `FINDINGS-production-readiness.md` — long-form readiness list (2026-07 arc).
- `PRODUCTION-READINESS-CHECKLIST.md` — checklist form of the same arc.
- `production-readiness-review-2026-07-14-v1.html` — first production-readiness
  review (2026-07-14 morning). Drove the Phase 1 hardening arc.
- `production-readiness-review-2026-07-14-v2.html` — refreshed v2 after Phase 1
  landed (2026-07-14 afternoon). Includes the Cursor GPT-5.2 second-opinion pass
  and the dependency taxonomy fix.

For design docs / plans / presentations (not audits), see `../history/`.
