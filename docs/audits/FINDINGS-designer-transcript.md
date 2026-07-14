# Findings: prior-designer transcript mining

Source: designer session `aea5bc4f` (45MB, ~180 user turns, 77 high-value insights) + the two
designer-cwd sessions (064498bf, 20e52037). Captured by the mining agent (a72de0d7); written to
disk by the main designer session (subagent Write was sandboxed). Evidence is paraphrase +
session reference; the raw transcript lines live in the JSONL.

---

## Critical bugs / gotchas
1. **Claude Code sends the wrong `cwd` to cmux's resume binding** → breaks NATIVE cmux resume.
   ccs is immune because it derives its own launch dir (ADR-0021). [VERIFY still true post-0.64]
2. **cmux workspace TITLE collision** → silent overwrites cause session misdirection when two
   workspaces share a title. This is WHY ccs keys identity/liveness on the surface UUID, not title.
   [→ runbook: platform Case-2]
3. **Role-directory hooks don't resolve** — Claude Code anchors config discovery to the launch cwd
   (the work target), never the role folder. ADR-0018: all hooks materialize to global
   `~/.claude/settings.json` with self-filtering.

## Major architectural decisions (rationale not fully in ADRs — feed the glossary)
4. **Control-plane / concierge SPLIT** — solves mid-conversation nagging from a dual-hat
   orchestrator. Control senses/acts on cadence; concierge judges WHEN to surface to Milad.
5. **Durable identity key = `[cluster]·role·[work-unit]`, NOT session-id** — the keystone that
   makes resume lossless. THE core concept.
6. **Inbox keyed by identity (role-scoped), survives session close.**
7. **Sessions are closable/resumable VESSELS, not disposable** — identity outlives the vessel.
8. **"Cluster" terminology (not "fleet")** — grouped as core roles + workers-by-epic.
9. **cmux tab determinism via the identity key** (PR#, phase color, epic) — not position/title.
10. **Catalogue lives in ccs because it must survive session close** (ADR-0023).

## Deferred ideas (with design detail)
11. Epic URLs + short names in cluster view.
12. A ccs TUI for fleet visualization (partly built — src/tui/).
13. Non-PR workflows support (generalize beyond pr-watch).
14. Slack scout sensor with detailed classification PRECEDENCE: **PR# > W-number > thread context**
    (now built as slack-scout — CONFIRM the precedence spec made it into the skill).
15. Agentic upkeep runbook (= tasks #3/#16 — confirms the need).
16. **A V3 learnings doc EXISTS: `docs/superpowers/specs/2026-07-10-v2-learnings-for-v3.md`** —
    READ IT, may hold more un-captured context.

## Operational gotchas (feed runbooks)
17. Workers hang on interactive prompts — FIXED with the acceptEdits launch flag.
18. Statusline backfill behavior on cold start.
19. PR template drift.
20. Screenshot quality gate — Cursor review is now a HARD gate (v25) for UI PRs.
21. PR comment-reading gap — worker missed feedback on #12089 (didn't read all review comments).

## State machine / idempotency / cmux specifics
22. Phase model colors: draft→yellow, review→blue, merged→green.
23. Resume idempotency proven via 148 passing tests (at that time).
24. cmux workspace-id is NOT exposed by cmux; rename is a shell-out.
25. Bootstrap-on-spawn contract: metadata stapled at birth (ADR-0047 lineage).

## Open questions raised
26. Where does epic context canonically live? (entity vs gotchas — see FINDINGS main §A24)
27. A diagram suite is needed: ccs↔cmux↔Claude Code mechanics + agent-state interaction.

## Recommended actions (from the miner)
1. Document phase semantics (the "done" confusion).
2. Capture the epic-context storage decision.
3. Write an ADR for the Slack scout.
4. Clarify the bootstrap-on-spawn contract.
5. Add the upkeep runbook.
6. Review the v3-learnings doc (item 16).
7. Build the diagram suite.
