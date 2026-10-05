# Go TUI

Bare `ccs` builds `tui-go/` into `tui-go/.bin/ccs-go` when a Go source is newer than the binary, then runs it full screen. It reads `index.db` and `catalogue.db` directly, read-only. Every write goes through the `ccs` on `PATH`, or `CCS_BINARY` when set.

## Sub-features

- A grouped list (cluster, then state) with a dossier pane showing summary, cost, model, meta, and a transcript peek.
- `/` fuzzy search over title, project and task subjects. It switches to the flat view, and `enter` keeps the filter.
- `t` retitle, which runs `ccs session-fields` (attach) and then `ccs session title`.
- `e` save or unsave, and `C` done or reopen, which run `ccs session save|unsave|complete|uncomplete`.
- `R` refresh, `g` view cycle, `v` transcript pager, `o` view options, `Tab` Skills mode, `q` quit.

## How to get to it (user POV)

Run `ccs` in a terminal.

## Driving it with the ccs sandbox

`tui.sh start`, then the browser steps in [`../SKILL.md`](../SKILL.md). The proved recipe: click the terminal, `/`, type `alpha`, `enter`, `t`, type a title, `enter`, `q`. The list must narrow to "Verify alpha session". The status line must read `retitled → <title>`. `catalogue-rows.txt` must hold the new title. Keys go through `preview_press`, and text through `preview_type` on `textarea[aria-label='Terminal input']`.

## Gotchas

- **Defect: spaces are dropped from the retitle, edit and ask inputs** (retitle, edit, ask). `handleInputKey` in `tui-go/ui/actions.go` appends only `tea.KeyRunes`, and bubbletea v1.3.10 delivers space as `tea.KeySpace`. If you type "a b", "ab" is persisted.
- **Defect: with fractional file modification times, the header reads `catalogue unavailable · source/index unreadable · recheck failed`**, even though `ccs catalogue-service check --json` reports healthy. The service emits fractional `sourceLatestMtimeMs` and `indexedLatestMtimeMs`, and `CatalogueSourceIndexStatus` in `tui-go/data/types.go` decodes them as `int64`. The list still renders, because it reads SQLite directly.
- `e` and `C` run the lifecycle verbs. Their workspace-close step stops at the cmux guard. See [lifecycle.md](lifecycle.md).
- `S`, `A`, `E` and `D` call a model provider, and the sandbox refuses them.
- `enter` on a row resumes it, which launches `claude`. Do not press it on a list row in a drive.
