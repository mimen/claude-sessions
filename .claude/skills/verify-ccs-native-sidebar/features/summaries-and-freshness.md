# Summaries and freshness

Two things the panel does continuously rather than on demand: it explains a session when you point
at it, and it keeps the whole list current without being asked.

## Sub-features

- `sum-hover` the summary control on a hovered row opens a popover with the session's account.
- `sum-window` the popover is a real window, so it extends past the sidebar's edge.
- `sum-chip` an enrichment verdict shows as a chip on the row itself.
- `fresh-sse` the client follows `/api/events` and refreshes on each revision.
- `fresh-poll` a backstop poll runs anyway: 1s while disconnected, 5s while connected.
- `fresh-action` any action forces an immediate refresh rather than waiting for the next tick.
- `fresh-clock` a running session's elapsed time ticks once a second.
- `fresh-degrade` a failed ordinary refresh keeps the current rows; a failed forced one retries once.

## How to get to it (user POV)

- Hover a row and point at its summary control.
- Everything else happens on its own: the list is expected to be current without interaction.

## Driving it with the CCS harnesses

Preconditions: server up; renderer built; for popovers, the live panel.

- **Summary content, headlessly.** `cd macos && ./.build/release/ccs-sidebar-render /tmp/rows.png 8 active 8787`
  shows the verdict chips on the rows. Compare against the snapshot's `summary` and `suggestion`
  objects for the same ids.
- **Popover.** Live only: hover the row's summary control, screenshot. The card carries the
  session's state and history, and it is allowed to overhang the sidebar — a card clipped to the
  panel's width is the bug this native surface exists to avoid.
- **The stream is alive.** `curl -N -s http://127.0.0.1:8787/api/events | head -5` prints revision
  events. Compare a revision here with `snapshotRevision` from a snapshot taken just after.
- **The extension is actually connected.** `tail -5 ~/Library/Containers/com.milad.ccs.sidebar.Extension/Data/Library/Caches/ccs-sidebar.log`
  — look for `change stream: connected to port 8787`. This is the extension's own word about its
  transport, written from inside its sandbox, and it is the fastest way to tell a stale panel from
  a stale server.
- **Refresh after an action.** Drive any lifecycle action and watch the row move within about a
  second, not five: `refreshNow` runs after every action. A row that takes the full poll interval
  means the forced refresh path is broken.
- **The clock.** Screenshot a running row twice, ten seconds apart. Its elapsed label advances; the
  rest of the row does not flicker.
- **Client discipline.** `swift test` covers the request rules in `SnapshotClientTests`: queued
  follow-ups collapse, forced liveness survives ordinary triggers, and a scope change cannot paint
  the previous scope's rows.

## Gotchas

- A revision is a wake-up, not a transaction barrier: a snapshot whose diagnostic stamp predates
  the announcement is still applied when it is the latest completed response. That is by design.
- "Correct at mount, drifts with uptime" is diagnostic, not cosmetic — compare the API before
  remounting, or you destroy the evidence that says which layer failed. See
  `docs/sidebar-concepts.md`.
- The working clock measures how long this panel has watched a session work, not the session's
  real start. A panel rebuilt a minute ago will say a minute.
- The diagnostics log is per container and survives reinstalls. An old `connected` line proves the
  extension connected once, not that it is connected now — check the timestamp.
- Hover is recomputed from the pointer's polled position, so a screenshot taken with the mouse
  parked elsewhere shows no hover state at all.
