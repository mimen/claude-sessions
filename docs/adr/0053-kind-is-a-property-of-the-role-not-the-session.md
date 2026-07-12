# `kind` (loop vs session) is a property of the ROLE, not the session; the session's copy is a derived cache

Decided with Milad 2026-07-10 after a resumed `eval` session rendered with no tab color. Extends
the files-are-truth model (ADR-0050 roles, ADR-0051 groupings, ADR-0052 run-location) to the last
piece of role identity still authored per-session.

## The incident

Two `eval` sessions existed; the resumed one (`0fa1fa66`) had `kind = "session"` on its catalogue
row while `roles/eval/role.toml` says `kind = "loop"`. `renderTab(row, row.kind)` trusted the row,
took the `renderSession` branch, and a no-PR/idle session yields `color = null` — so the tab had no
color. A loop would have been Purple. The definition and the row disagreed, and the renderer read
the wrong one.

## Why this happened — `kind` was denormalized

`kind` was authoritative in `role.toml` (a loop is a role with a `resume_command`) but ALSO copied
onto every catalogue row at `new-session` time. The copy is stamped from `--kind` at spawn; a
session born without it (or before the role's kind was set) defaults to `session` and never
re-syncs. So the per-session copy drifts from the role definition. The tell that it lived in the
wrong place: a manual loop↔session TOGGLE keybind existed in the TUI (App.tsx) whose only purpose
was to hand-correct this drift.

## The realization — a loop is a kind of ROLE

A "loop" is operationally "a role that comes back running" — a role with a `resume_command`
(ADR-0015/0048). That is inherently a role property: every embodiment of `eval` is a loop because
`eval` is a loop role. There is no coherent state where one `eval` session is a loop and another is
not. And since any loop we run implies a defined role (we'd never run an ad-hoc loop without one), a
role-LESS session is never a loop. So `kind` is fully derivable: `resolveRole(row.role).kind`, with
`session` as the default when there is no role. Nothing about it needs per-session authoring.

## Decision — the role owns `kind`; the session's `kind` is a derived cache, never authored

- **`role.toml`'s `kind` is authoritative** (already true — ADR-0048). A role is a loop iff its
  definition says so (equivalently, iff it has a `resume_command`).
- **Readers derive `kind` from the role**, not from an authored session field: `render-tab`, the
  TUI loop grouping (`groupsView`/`stateGroups`), the board `LOOP` badge + `--loops` filter, and
  Preview all resolve via the role. A session with no role → `session`.
- **The catalogue `kind` column survives ONLY as a derived cache** — re-sourced from the role (the
  same "index.db is a deletable cache of the files" pattern, ADR-0049). It is written from the role
  definition, NEVER authored per-session, so it cannot drift. SQL filters that need it (`--loops`,
  the loops grouping) keep reading the column; it's just guaranteed to match the role now. Its
  value is whatever `resolveRole(role).kind` yields at materialization/sense time.
- **The manual loop↔session toggle is removed.** You change a role's kind by editing its
  `role.toml`, not by flipping a session. (Role-less sessions are never loops, so nothing is lost.)

## Consequences

- **eval-style drift is impossible.** A loop role's sessions always render/group/badge as loops,
  regardless of how (or when) each row was born. The live `0fa1fa66` row was corrected to `loop` as
  a one-off; going forward the derivation makes such fixups unnecessary.
- **`new-session` stops requiring `--kind`** for a role-backed spawn — kind comes from the role
  (like home/resume_command already do, ADR-0048). An explicit `--kind` on a role-less reserve is
  the only remaining author, and it only ever sets `session`.
- **Parallels ADR-0050/0051/0052**: name, cluster, home, skills, commands, hooks, run-location, and
  now kind are all DERIVED from the role's files; the session row is a cache of position + facts,
  not a second source of truth for identity.
- **Migration:** re-materialize the `kind` column from role definitions for existing rows (a
  sync-roles-style pass, or lazily on next sense), then drop the per-session author path and the TUI
  toggle. Rows whose role is a loop become `loop`; role-less rows stay `session`.
- **Interacts with the still-open `kind`-derivation follow-up in the renderer**: `renderTab` should
  take the resolved kind (from the role) rather than `row.kind` directly, so a stale cache can never
  again pick the wrong template. This is the concrete first reader to convert.
