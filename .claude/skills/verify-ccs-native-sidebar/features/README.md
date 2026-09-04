# CCS native sidebar verification map

The maintained source for verifying what a user can do in the native cmux sidebar. Read this index,
then use the matching feature file as the recipe. `../SKILL.md` holds launch, doctor, cleanup and
the harnesses; this directory holds what to point them at.

## Baseline preconditions

- The sidebar server answers on 8787 (the resident LaunchAgent) or on your own spare port.
- `macos/.build/release/ccs-sidebar-render` exists: `cd macos && swift build -c release`.
- `../doctor.sh` reports the server up, the stores readable, and the installed appex's SHA.
- For live-panel work only: the appex SHA matches `git HEAD`, cmux's provider is
  `cmux.sidebar.extensions`, and peekaboo has Screen Recording.
- There is one installed extension and it is the one the user is looking at. Treat every live
  action as happening to real work, because it is.

## Driving conventions

- Pick the cheapest harness that can see the change: render → `swift test` → server → live panel.
- Read what you captured. A PNG nobody looked at and a snapshot nobody parsed are not evidence.
- Quote session ids in full. Live sessions share long id prefixes.
- The panel has no accessibility tree. Live clicks are global coordinates read off a fresh
  screenshot, never remembered coordinates from an earlier run.
- Never mutate a real session to demonstrate a mutation. Use a session you created, or the fork
  stack on 8788 against `cmux CCS.app`.
- Restore nothing after a read. Restore everything after a mutation, and say what you touched.

## Proof and skip reporting

- Capture the action and the resulting state, not only the end state.
- A visual claim carries a render or screenshot; a state claim carries the snapshot JSON field or
  the `sqlite3` row; a mutation claim carries both, plus the before.
- Name the harness and the SHA (`doctor.sh` output) beside every artifact.
- An unreachable path is reported with the command tried and the precondition that was missing.
  Do not report a path proved through a different entry point as proved.

## Feature entry contract

Each file: an H1, one paragraph of user-visible behavior, then exactly four H2s —
`Sub-features`, `How to get to it (user POV)`, `Driving it with the CCS harnesses`, `Gotchas`.

## Features

- [The queue](./queue.md) — rows, sections, grouping, and what the panel says when a store is unreadable.
- [Opening a session](./open-and-focus.md) — the click that focuses a live workspace or resumes a dead one.
- [Lifecycle](./lifecycle.md) — save, done, reopen, close tab, incognito, and accepting or dismissing a verdict.
- [Destroy](./destroy.md) — the irreversible one, its preflight, and its confirmation.
- [Shaping the list](./shaping.md) — scope, filter, grouping, row layouts, clusters, and per-group visibility.
- [Summaries and freshness](./summaries-and-freshness.md) — hover summaries, the working clock, SSE and poll.
