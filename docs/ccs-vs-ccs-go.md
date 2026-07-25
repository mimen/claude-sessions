# `ccs` (Ink/TS) vs `ccs-go` — complete diff

Verified against real code on 2026-07-24.
Ink side: `/Users/mimen/Programming/Repos/claude-sessions` @ branch `fix/transactional-catalogue-migrations`.
Go side: `/Users/mimen/Programming/Repos/ccs-go` @ `feat/navigate-led-redesign`.

Both are installed and run side by side: `ccs` (Ink) · `ccs-go` (Go).

---

## 0. Headline findings (read this first)

1. **The `R`-refresh / autorefresh you remembered is NOT in shipped Ink.** It exists only on the unmerged
   branch `wip/phase1-managed-session-birth`. Shipped Ink has **no polling and no refresh key** — it only
   reloads after its own writes. **ccs-go genuinely has both** (`R` + an autorefresh ticker).
2. **Ink writes DIRECTLY to SQLite.** `C`/`X` call `setCompleted`/`setArchived`, and `e`/`:` call
   `applyMutations` — all straight into `catalogue.db`, no CLI boundary. **ccs-go shells every write through
   `ccs`**, so it can't drift from the TS write path or bypass invariants. Architecturally ccs-go is stricter.
3. **Ink's `L` key is dead.** `Help.tsx` advertises "L / C / X — mark as loop / done / archived", but there is
   no `L` handler anywhere. (This is why my earlier feature survey listed `L` — I was repeating Ink's own
   incorrect help text.)
4. **Ink is far richer in views, search, skills, and dossier depth.** ccs-go is leaner and faster to first
   paint, with a cleaner write path and better refresh story.
5. **Ink persists prefs** (view + engine survive restarts). ccs-go persists nothing.

---

## 1. Keymap

### In both (same meaning)
`↑/k` `↓/j` move · `enter` resume · `r` route picker · `v` transcript · `/` search · `t` retitle ·
`C` mark done · `X` archive · `p` toggle preview · `g` cycle view · `J`/`K` scroll peek · `Tab` skills ·
`?` help · `q` quit

### Ink only
| Key | Action |
|---|---|
| `→`/`l`, `←`/`h` | **expand / collapse** sections and session children |
| `d` | dossier ⇄ compact peek toggle |
| `s` | cycle sort (ccs-go moved this into the `o` pane) |
| `a` / `u` / `A` | toggle subagents / auxiliary / archived (ccs-go: in `o` pane) |
| `U` | cycle task filter (ccs-go: in `o` pane) |
| `i` | swap inference engine (codex ⇄ claude) |
| `f` | fork-resume (new id, same history) |
| `o` | resume via the *other* target (inline ↔ cmux) |
| `:` | NL metadata reorg across **all** sessions |
| `e` | NL metadata edit of selected session |

### ccs-go only
| Key | Action |
|---|---|
| `o` | **View Options pane** (sort, archived/subagents/auxiliary, task filter, autorefresh + interval) |
| `R` | **refresh** — re-scan store, keep selection |
| `e` | **instant archive** (no confirm; cursor lands on next session) |
| `E` | AI metadata edit (Ink's `e`) |
| `S` | AI session summary |
| `A` | ask-the-fleet (semantic search across transcripts) |
| `D` | AI cleanup proposals (batch archive with reasons) |

> ⚠️ **`e` and `o` mean different things in the two tools.** Ink: `e` = AI edit, `o` = other resume target.
> ccs-go: `e` = archive, `o` = options. Muscle memory will collide.

---

## 2. Views & grouping

| | Ink | ccs-go |
|---|---|---|
| Views | **6**: `groups → state → flat → tree → cluster → epic` | **3**: `default (cluster+state) → tree → flat` |
| Default | `cluster`, **persisted** in `prefs.json` | `default`, not persisted |
| Sort | `s` cycles recent → cost → msgs | in `o` pane; same three |
| Collapse | `DEFAULT_COLLAPSED` for stale/done/archived/solo | none — no expand/collapse at all |

Ink's `cluster` view groups by system → CORE roles vs WORKERS-by-epic. ccs-go's default merges the concepts:
cluster groups on top (roles flattened into a column), then a `(no-system)` remainder split by lifecycle state.
Ink's `epic` view has no ccs-go equivalent (deliberately cut).

## 3. Filters & visibility

Identical *semantics*, different surface: Ink uses four keys (`a`/`u`/`A`/`U`), ccs-go puts all four in the `o`
pane plus autorefresh controls. Task filter states match (`all → open/unfinished → interrupted`).

## 4. Preview / inspection

| | Ink | ccs-go |
|---|---|---|
| Modes | compact peek **and** full dossier (`d` toggles) | one dossier, always |
| Transcript peek | in-sidebar, lazy-loaded, race-guarded per-session cache | in-sidebar (**being removed** — see enrichment plan) |
| Dossier depth | OPEN TASKS block (5 + "N more", blocked-by), tokens in/out/**cache**, top-3 models w/ cost, **burn/day**, cadence · ticks, parent/epic/review/GUS/PR | cost self/total + per-provider bars, model, tasks, cwd, duration, subagents, class, cluster, stage, PR, last |
| Links | **OSC-8 hyperlinks** — clickable PR / GUS / epic / review-app | none |
| Section focus | dedicated `SectionCard` so layout never collapses | plain |
| Full reader `v` | wraps at width-8, role gutter, `%` scroll | same idea, own implementation |

## 5. Write / organize

| | Ink | ccs-go |
|---|---|---|
| Retitle `t` | **AI-generated** via titler (not user-typed) | **user-typed** prompt → `ccs session title` |
| Done/archive | direct SQLite `setCompleted`/`setArchived` (toggling) | `ccs mark --completed/--archived` |
| AI edit | `e` (single) and `:` (all sessions) → direct `applyMutations` | `E` (single only) → mutations applied via `ccs` |
| Engine swap | `i`, persisted | none (fixed) |
| Cursor after action | follows the session into its new section | **stays put** (lands on next session) |

## 6. Resume

**Resume is at near-parity — only two keys are missing.** (An earlier draft of this doc listed ported
features under a "Ink is more capable" heading, which was misleading. Corrected below.)

**At parity — ccs-go has all of these:**
- **Live-session guard** — if the session is already open, focus the existing cmux workspace instead of
  spawning a duplicate (`resume.FocusLive`).
- **cwd drift recovery** — verifies the recorded cwd's encoded realpath matches the storage folder; if not,
  walks the filesystem to find the right dir, fails closed.
- **Both resume targets** — `inline` (hands over stdin/stdout, replaces the TUI in this terminal) and
  `cmux` (opens a new focused workspace). Offered in the `r` route picker.
- Inline handoff happens after the TUI exits.

**Missing in ccs-go — exactly two:**
- **`f` fork-resume** — resume into a **new session id that inherits the same history**. The original
  session record stays untouched; you branch off it. Use when you want to explore a different direction
  without polluting the original, or revive an old session without disturbing its record.
- **`o` resume via the *other* target** — one keystroke that flips inline ↔ cmux for this resume, instead
  of opening the picker and choosing. i.e. "do the opposite of my default, now."

## 7. Rows & columns

Ink renders more per row: classification badge, PR# (state-colored), identity/event label, **PHASE** and
**ROLE** (cluster view only), tasks `▣ done/total`, model, cost, age, sub-count — with conditional columns
based on terminal width. ccs-go renders: state dot, title, stage, model, cost, age, sub.

ccs-go **strips leading `*`/`·` markers** from titles; Ink strips baked-in spinner frames (`stripSpinnerPrefix`).
Ink's cost column is deliberately faint until ≥ $500; ccs-go uses graded tiers throughout.

## 8. Header dashboard

Effectively identical (host · sessions · spend · active · parked; loops · in-subagents · top). ccs-go also
shows the active view + sort on the right.

## 9. Background / runtime

| | Ink | ccs-go |
|---|---|---|
| Startup | **full `scanStore()` + `await reindexStore()` before first paint** | reads the already-built index; no reindex |
| Refresh | **none** (event-driven after own writes only) | `R` manual + autorefresh ticker (default 8s) |
| cmux probes | async at mount (sync spawn causes a React crash — heavily commented) | `cmux tree --json` subprocess per load (~65–85ms) |
| Background AI | `backfillTitles` runs on mount (headless titler) | none on mount; all AI is on-demand (`S`/`A`/`D`/`E`) |
| DBs opened | 3 (index, catalogue, skills) read-write | same 3, **`mode=ro`** |
| Crash reporting | breadcrumbs at every stage | none |

Measured ccs-go full load ≈ **330–450 ms** (high variance, dominated by the cmux subprocess). Ink's first
paint is gated on a full store scan + reindex, so it should be slower — but I could not time an interactive
first-paint reliably; **verify by eye**.

## 10. Skills mode

Ink's is *much* richer. Both have: list, search, grouping, preview, multi-file reader, `R` rescan.
**Ink additionally has**: context lens (`x`: claude@~ / claude@cwd / codex / hermes / cursor / agents),
sort (`S`), unused-only (`u`), show-duplicates (`w`), and real actions — `o` open in editor, `f` reveal in
Finder, `e` edit SKILL.md, `y` copy path, `c` set category, `t` toggle tag, `X` archive to vault,
**`s` cross-jump to sessions that used the skill**. ccs-go's is read-only browsing.

## 11. Search

- **Ink: two-stage.** `fuzzysort` over title/project/**task subjects**, then **FTS full-text content matches**
  appended for sessions not already matched by name. A title hit always outranks a body mention.
- **ccs-go: fuzzy only** (title/project/task subjects). No full-text. Semantic search lives behind `A`
  (ask-the-fleet, LLM-backed) instead.

## 12. Terminal handling

| | Ink | ccs-go |
|---|---|---|
| Narrow terminals | side-by-side only ≥100 cols; **otherwise preview stacks below**; conditional columns | fixed 58/42 split at any width |
| Resize | `useTerminalSize()` subscribes to stdout resize | `tea.WindowSizeMsg` |
| Mouse | **none** | **none** |

---

## 13. Gaps to close before retiring `ccs`

**Blocking (real daily-use features ccs-go lacks):**
1. `f` fork-resume and `o` inline↔cmux swap
2. Expand/collapse (`→`/`←`) — with 340 sessions, no collapse is a real ergonomic loss
3. FTS full-text search
4. Prefs persistence (view/sort should survive restart)
5. Narrow-terminal layout (stacked preview)

**Notable but lower priority:**
6. `epic` + `groups` + `state` views (ccs-go has 3 of 6)
7. Skills-mode actions (open/edit/tag/category/archive/cross-jump)
8. OSC-8 clickable PR/GUS/epic links
9. Dossier depth: OPEN TASKS block, burn/day, cache tokens, top-3 models
10. `:` bulk NL reorg
11. Compact-peek mode (`d` toggle)

**Deliberately not porting:** `i` engine swap, `L` (doesn't exist in Ink either).

## 14. Where ccs-go is already better

- Writes go through `ccs` — no duplicate write path, no bypassed invariants
- Real refresh + autorefresh (shipped Ink has neither)
- Cursor preservation while triaging (Ink follows the session into its new section)
- On-demand AI: `S` summary, `A` ask-the-fleet, `D` cleanup proposals
- Consolidated View Options pane instead of six scattered toggle keys
- `mode=ro` reads — cannot corrupt the store
- Faster first paint (no reindex-before-render)
