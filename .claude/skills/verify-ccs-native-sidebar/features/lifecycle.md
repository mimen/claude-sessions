# Lifecycle

Moving a session out of the way, or back into it: save for later, mark done, reopen, close its tab,
hide it as incognito, and accept or dismiss the enrichment verdict the row is asking about.

## Sub-features

- `life-save` moves an active session to Saved, and `Move to Active` moves it back.
- `life-done` completes a session; `life-reopen` returns a completed one to Active.
- `life-close-tab` closes the cmux tab without touching the session.
- `life-incognito` hides a session from every CCS listing.
- `life-accept` accepts an actionable verdict, which lands on the same `complete` command.
- `life-dismiss` dismisses the verdict without acting on it.
- `life-copy-summary` copies the session's summary to the clipboard.
- `life-workspace-only` a tab with no session offers `Close tab` and nothing else.
- `life-error` a refused action shows the server's own message and leaves the row alone.

## How to get to it (user POV)

- Hover a row: bookmark (`Save for later` / `Move to Active`), checkmark (`Mark done`), and — only
  when the row has a tab — a red `Close tab`.
- Right-click a row: the verdict section first, then `Lifecycle`, then the session commands.

## Driving it with the CCS harnesses

Preconditions: a session you own; note its full id and current lifecycle first:
`sqlite3 ~/.ccs/cache/catalogue.db "select lifecycle, incognito from sessions where session_id='<id>';"`.

- **Hover controls exist.** `cd macos && ./.build/release/ccs-sidebar-render /tmp/hover.png 6 active 8787`.
  Every row is drawn twice, the second one hovered: the bookmark and checkmark appear on the hovered
  copy, and the red close only on rows that have a tab.
- **Menu contents.** Right-click a row live: `peekaboo click --coords <x>,<y> --global-coords --right`,
  then screenshot. A completed row offers `Reopen`; an active one offers `Save for later` and
  `Mark done`; a workspace-only row offers only `Close tab`.
- **Save.** Choose `Save for later`, then re-read the catalogue: `lifecycle` is `saved`, the row
  leaves Active, and it appears under the Saved scope. Undo with `Move to Active`.
- **Done and reopen.** `Mark done` → `lifecycle` is `completed` and the row moves to the Done scope.
  `Reopen` returns it to `active`.
- **Server half alone.** `curl -s -X POST http://127.0.0.1:8787/api/session/lifecycle
  -H 'Content-Type: application/json' -d '{"sessionId":"<full-id>","action":"save"}'` — the verbs are
  `save`, `unsave`, `complete`, `uncomplete`. Prove the catalogue changed, and say you drove the
  endpoint rather than the menu.
- **Incognito.** `/api/session/incognito` with `{"sessionId":"…","incognito":true}`. The session
  disappears from `ccs ls` and from the snapshot. Set it back to `false` unless the point was to
  hide it.
- **Verdict.** A row with `suggestion.actionable` shows `Accept`; `/api/session/decline` with the
  row's `suggestion.verb` dismisses it. After dismissal the chip is gone from the next snapshot.
- **Proof.** Before and after: the snapshot row (`lifecycle`, `suggestion`), the catalogue row, and
  a screenshot of the row in its new section.

## Gotchas

- `Accept` and `Mark done` post the identical `complete` command. Proving one does not prove the
  other's menu item exists — check the section header the verdict is under.
- `Close tab` only appears where `workspaceRef` is present; a row without a tab has nothing to
  close, and its absence is correct behaviour, not a missing button.
- Lifecycle is the server's, and the client mutates nothing locally: the row moves when the next
  snapshot says so, roughly a second later. A row that has not moved yet is not a failure.
- Incognito hides a session from every listing including the ones you would use to check your work.
  Query the catalogue directly, and remember what you hid.
- The hover controls only render for a live pointer. The renderer's `isHovered` copy is how you see
  them without one; a screenshot taken while the mouse is elsewhere will not show them.
