# The queue

The panel's whole point: one scrolling list of sessions, grouped into sections the server chose,
each row saying what the session is, where it lives, and what it is doing right now.

## Sub-features

- `queue-rows` renders one row per session the snapshot returned, in the server's order.
- `queue-sections` groups rows under the section each row names, in first-appearance order.
- `queue-row-facts` shows title, project, category, model, worktree, tab state and age on the row.
- `queue-ghosts` draws closed sessions as ghost rows, without status or model.
- `queue-notices` surfaces `livenessReadable` / `indexReadable` / `catalogueReadable` being false,
  and a truncated response (`hasMoreRows`), as notices rather than silence.
- `queue-empty` says so when a scope holds nothing, instead of showing a blank panel.

## How to get to it (user POV)

- Open cmux with the CCS Sessions extension selected as the sidebar provider. The queue is the
  panel; there is no other entry point.

## Driving it with the CCS harnesses

Preconditions: server up; `../doctor.sh` clean; renderer built.

- **Rows as pixels.** Render the first fourteen active rows twice each, at rest and hovered:
  `cd macos && ./.build/release/ccs-sidebar-render /tmp/queue.png 14 active 8787`. Read the PNG.
  Titles, project, category, model and age appear on every row.
- **Rows as data.** `curl -s 'http://127.0.0.1:8787/api/snapshot?limit=2000&scope=active&include=saved'`.
  Every row in the PNG appears here with the same name and section, in the same order.
- **Sections.** `curl -s '...&scope=active&include=saved' | python3 -c 'import json,sys;
  [print(r["section"], r["name"]) for r in json.load(sys.stdin)["rows"]]'`. The panel's section
  headers are these values, deduplicated in first-appearance order — the client never re-sorts.
- **Ghosts.** Ask for a closed scope: `...&scope=completed&include=active,saved,completed,t3`, then
  render it: `./.build/release/ccs-sidebar-render /tmp/ghosts.png 10 completed 8787`. Closed rows
  keep the grid and lose the status pill and model.
- **Notices.** Read `livenessReadable`, `indexReadable`, `catalogueReadable` and `hasMoreRows` from
  the snapshot's top level and compare against what the panel shows. A false flag with no notice on
  screen is the bug.
- **Live proof.** `../shot.sh docs/evidence/native-sidebar/<stamp>/queue.png`, then read it against
  the same snapshot. This is the only harness that shows real scrolling.

## Gotchas

- `limit=1` does not return one row. Read `len(rows)` rather than assuming the limit was honoured.
- The renderer cannot draw `ScrollView` or `LazyVStack`; it stacks rows plainly. Nothing about
  scroll position, section stickiness or list virtualisation can be proved from a PNG.
- Closed scopes must be requested explicitly with `include=`; the server only projects a section
  it was asked for, so a missing row is often a missing query parameter.
- `generatedAt` is `0` in ordinary responses. Use `snapshotRevision` to tell two snapshots apart.
- Category colour comes from the vault's category registry. When
  `categoryProjectionError` is set the rows are correct and the category marks are not — check
  that field before filing a "wrong colour" bug.
