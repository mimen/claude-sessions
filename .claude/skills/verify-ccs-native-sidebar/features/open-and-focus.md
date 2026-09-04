# Opening a session

One click, one meaning: show me that session. The server decides whether that means focusing a live
cmux workspace or resuming a dead session, and the row lights up immediately rather than waiting
for the round trip.

## Sub-features

- `open-focus` a live row focuses its existing cmux workspace.
- `open-resume` a row with no workspace resumes the session through CCS into a new one.
- `open-optimistic` the clicked row paints focused at once, for at most four seconds.
- `open-confirm` the next snapshot's `focused` row retires the optimistic override.
- `open-expire` a failed open lets the override expire, handing the highlight back to the server.
- `open-completed-guard` clicking a Done row asks before bringing it back to Active.
- `open-t3-guard` a closed T3-associated row asks a second time, and approval covers one request.
- `open-failure` a refused open shows the server's own words, not a generic apology.
- `open-jump-badges` holding Command paints `⌘1`–`⌘9` on the first nine visible rows.

## How to get to it (user POV)

- Click a row in the panel.
- Hold Command to see the jump badges — but read the Gotchas before treating them as a path.

## Driving it with the CCS harnesses

Preconditions: server up; a session you own to click; `cmux tree --all --json` readable.

- **Which row the server thinks is focused.** `curl -s 'http://127.0.0.1:8787/api/snapshot?limit=2000&scope=active&include=saved'
  | python3 -c 'import json,sys; print([r["id"] for r in json.load(sys.stdin)["rows"] if r.get("focused")])'`.
  Exactly one, and it matches cmux's active workspace:
  `cmux tree --all --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["active"])'`.
- **Focus a live row.** Screenshot the panel, click the row's coordinates:
  `peekaboo click --coords <x>,<y> --global-coords --foreground`. Within a second cmux shows that
  workspace, and the snapshot's `focused` id becomes that row's id. Screenshot before and after.
- **Server half alone.** `curl -s -X POST http://127.0.0.1:8787/api/workspace/focus -H 'Content-Type: application/json'
  -d '{"workspaceId":"<uuid>"}'`. Proves the endpoint, not the row; say which you proved.
- **Resume a dead session.** Click a row with no tab, or
  `curl -s -X POST http://127.0.0.1:8787/api/open -d '{"sessionId":"<full-id>"}'`. A new workspace
  appears in `cmux tree --all --json` and the row gains a `workspaceId` in the next snapshot.
- **Completed guard.** Click a row in the Done scope. The panel asks before reopening; approving
  posts `{"sessionId":"…","reopenCompleted":true}` and the catalogue lifecycle returns to `active`:
  `sqlite3 ~/.ccs/cache/catalogue.db "select lifecycle from sessions where session_id='<id>';"`.
- **Optimistic paint.** Click, then screenshot within four seconds and again after ten. The row is
  lit in both when the open succeeded; the highlight returns to the server's row when it failed.

## Gotchas

- Focus is snapshot truth plus a four-second override. A highlight that outlives both is layer-5
  accumulated state — see `docs/sidebar-concepts.md`.
- Never guess between focus and resume from the client side: choosing wrong spawns a duplicate of a
  running session. That decision belongs to the server, and a proof that bypasses it proves nothing.
- Resuming through the sidebar creates a real workspace in the user's cmux. Close what you opened.
- T3-associated rows carry a second confirmation, and approving it covers exactly one request.
- The row id and the session id are not always the same field; post `row["sessionId"]` when it is
  present, and never a truncated one.
- The `⌘1`–`⌘9` badges are drawn but not wired at `b0425f0`: `SidebarRootView.jump(to:in:)` is
  handed to `SessionListView` as `onJump` and nothing ever calls it. Verify the badges appear
  while Command is held; do not report the shortcut itself as working until something invokes
  `onJump`.
