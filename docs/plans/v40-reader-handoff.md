# v40 enrichment: handoff for the two out-of-branch readers

Written 2026-07-26 from `worktree-session-enrichment-v40`. The v40 schema is live: the catalogue
carries `enrichment_state` / `_history` / `_next` / `_remaining`, and all 476 top-level sessions
have been re-enriched into that shape.

Two reading surfaces still consume the v39 shape. Both are **currently correct** because
`setEnrichment` dual-writes (`src/catalogue/db.ts`, `enrichment_summary = $state`,
`enrichment_outstanding = $next`), so neither is broken today. Both lose data when v41 drops the
old columns.

## Field mapping

| v39 | v40 | Note |
|---|---|---|
| `enrichment_summary` | `enrichment_state` | Now state-first and present tense, ~211 chars (was 404). No longer a chronicle. |
| — | `enrichment_history` | **New.** How it got there, past tense. Render on demand, not by default. |
| `enrichment_outstanding` | `enrichment_next` | Now exactly ONE imperative action, ~88 chars. |
| — | `enrichment_remaining` | **New.** Everything open after `next`. Render dimmer. |
| `enrichment_reason` | `enrichment_reason` | **Now conditional** — non-empty only for `archive` / `handoff` / `junk`. Empty on continue/complete by construction, so `if (reason)` is the correct guard. |
| `enrichment_cwd_correct` | same | **Now nullable.** NULL = the cwd question was never asked (no location registry at generation time). Must NOT render a warning for NULL — only for explicit `false`. |
| `enrichment_junk` | same | Now implies `recommendation = 'archive'`. |

Reference implementations in this branch: `src/tui/Preview.tsx` (the enrichment block pushed into
`H`), `src/catalogue/session-command.ts` (the `─ enrichment` block), `src/enrich/command.ts`.

---

## 1. The cmux CCS sidebar

**Where:** `.claude/worktrees/cmux-t3-sidebar-v1/src/sidebar/` on branch
`worktree-cmux-t3-sidebar-v1` (a worktree of this repo; committed, clean, unmerged — `master` has no
`src/sidebar`). Running live as PID-of-the-day: `bun bin/ccs sidebar serve --port 8787`, mounted via
`~/.config/cmux/sidebars/ccs-web.url`.

**What to change:**

1. `src/sidebar/snapshot.ts` ~458-506, `readEnrichmentSummaries()` — the only enrichment SQL. It
   selects `enrichment_summary`, `_outstanding`, `_reason`, `_recommendation`, `_at_messages` and
   is gated on `if (!columns.has("enrichment_summary")) return summaries;`. Add `enrichment_state`,
   `_next`, `_remaining`, `_history`, `_title`, and move the presence gate onto
   `enrichment_state`.
2. `src/sidebar/projection.ts` — extend `SessionEnrichment` / `SidebarSummary` with the new fields.
3. `src/sidebar/web/components/session-row.tsx` ~102-142 (hover card) — render `state` where
   `summary` is now, and **add `next`**, which today is read but never displayed (it only reaches
   the clipboard via `summaryAsText` ~86-93). The most actionable field in the record is currently
   invisible on screen.
4. `session-row.tsx` ~339 — `row.name` resolves `cmux workspace title → index title` and never
   reads `enrichment_title`, so v40's titling work does not reach the sidebar at all. Consider
   slotting it in, matching `displayTitle()` in `src/catalogue/db.ts`.

**The landmine.** When v41 drops `enrichment_summary`, the presence gate returns an empty map, every
hover card and "Copy summary" silently disappears, and `catalogueReadable` stays true so no toast
fires. Failure is invisible. Fix the gate before v41, not after.

**Also:** this branch declares `CATALOGUE_VERSION = 37`. See the version-stamp note below.

## 2. The ccs-go dossier

**Where:** `tui-go/` in this repo (was `~/Programming/Repos/ccs-go`, now removed).

**What to change:**

1. `data/sqlite.go` ~352-362 — add the four new columns to the presence-guarded select.
2. `data/types.go` ~92-108 — `Summary`/`Outstanding` become `State`/`Next`, plus `History` and
   `Remaining`. `CWDCorrect bool` should become a tri-state; today NULL scans to `false` via
   `sql.NullInt64` and is only saved from rendering a false warning by the empty-target guard in
   the view.
3. `ui/enrichment_view.go` — `renderEnrichment` already has the right shape (verdict pill, stale
   label, prose, hanging-indent `open`, cwd line). Map `Summary → State`, `Outstanding → Next`, add
   a dim `also` line for `Remaining`, and put `History` behind a keypress.
4. `renderEnrichment` prints `reason` unconditionally — now correct as-is, since empty means
   "verdict needs no justification", but the blank line above it should be suppressed when empty.

**Worth adding while you are there:** the dossier is the natural home for the **render-time world
banner** (v40 decision 8). `src/enrich/world.ts` computes it — cwd existence, whether the session's
branch still exists, and how many later sessions ran in the same directory. Recomputing at render
is the point: world state changes while a session sits still, so a stored verdict rots silently.

---

## The version-stamp problem you will hit

`migrate()` in `src/catalogue/db.ts` ends with:

```ts
if (v !== CATALOGUE_VERSION) db.exec(`PRAGMA user_version = ${CATALOGUE_VERSION};`);
```

That stamps **downward** as well as up. Three binaries at three versions currently open the live
catalogue — this branch (40), the deployment (39), and the running sidebar (37) — so the stamp
thrashes, and every `openCatalogue()` re-runs the whole migration chain. Observed: 40 → 39 → 37
within seconds.

It is harmless today only because every migration block is presence-guarded (`if
(!hasColumn(...))`), so re-running is a no-op and nothing is ever dropped.

**It stops being harmless at v41,** which is the first DESTRUCTIVE migration. Sequence to avoid: v41
drops `enrichment_summary` and stamps 41 → the v37 sidebar stamps 37 → a v41 binary re-runs the v38
block, which re-ADDS `enrichment_summary` as an empty column, then v41 drops it again. Readers in
that window see an empty column rather than a missing one, which is the difference between a
presence gate firing and a gate silently passing with blank data.

Before v41 ships, either bring every reader to the same `CATALOGUE_VERSION`, or make the stamp
monotonic (refuse to lower it), or make v41 not depend on the stamp at all.
