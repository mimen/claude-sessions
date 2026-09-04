# Destroy

The one irreversible command in the panel: erase a session and its descendants from this machine.
It sits alone at the bottom of the context menu, behind a confirmation that names what goes with it.

## Sub-features

- `destroy-menu` the command is present, separated, and destructive-styled.
- `destroy-preflight` choosing it asks the server what else would go, before anything is erased.
- `destroy-detail` the confirmation names the session and its descendant count in its own words.
- `destroy-cancel` cancelling erases nothing.
- `destroy-run` confirming removes the session, its descendants, and its row.

## How to get to it (user POV)

- Right-click a row, then the destroy command at the bottom of the menu.

## Driving it with the CCS harnesses

Preconditions: **a session you created for this purpose and are willing to lose.** Never a real one.
Record its id and descendants first:
`sqlite3 ~/.ccs/cache/catalogue.db "select session_id, parent_session_id from sessions where session_id='<id>' or parent_session_id='<id>';"`.

- **Preflight, without destroying.** `curl -s -X POST http://127.0.0.1:8787/api/session/destroy/preflight
  -H 'Content-Type: application/json' -d '{"sessionId":"<full-id>"}'`. The response's
  `descendantCount` is what the dialog quotes back. Compare it with the catalogue query above; a
  mismatch is the bug, and it is the reason this feature has a preflight at all.
- **Dialog text.** Right-click the row and choose destroy: `peekaboo click --coords <x>,<y> --global-coords --right`,
  screenshot, click the destroy item, screenshot again. The dialog reads
  `Destroy this session?` and, when there are descendants, `This erases “<name>” and N descendant
  session(s). It cannot be undone.` with the same N the preflight returned.
- **Cancel.** Choose `Cancel`. The dialog closes, the row is still there, and the catalogue row is
  unchanged. This is the only half of the feature safe to drive on a session you care about.
- **Run it.** Only on the disposable session: confirm `Destroy`. Afterwards the catalogue has no
  row for it or its descendants, the transcript is gone from the store, and the row is absent from
  the next snapshot.
- **Proof.** Preflight response, the dialog screenshot, and the catalogue query before and after.

## Gotchas

- Nothing undoes this: not the catalogue, not the index, not the transcript. There is no dry run
  other than the preflight, and the preflight is a read.
- The descendant count in the dialog comes from the preflight, not from the row. A dialog that says
  zero while the catalogue has children means the preflight is answering about the wrong id.
- Destroy takes `row.sessionId ?? row.id` — a truncated or wrong id can name a different session,
  and the confirmation is the last place that mistake is visible.
- Never demonstrate this endpoint "to check it works". Erasing a real session to prove a menu item
  is a worse outcome than an unproved menu item.
