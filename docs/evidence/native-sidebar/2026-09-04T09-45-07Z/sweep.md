# Full sweep of the native sidebar, 2026-09-04

Second pass over the same evidence directory: everything the harnesses can reach without Screen
Recording, which is still ungranted (the System Settings toggle raises an admin password sheet).

## What was driven

- **Scopes.** Narrow queries, as the client sends them: `active&include=saved` → 131 rows;
  `saved` → 1; `completed` → 80; `t3` → 72 (sections `completed` and `recent`); `triage` → 139.
  The wide search query (`include=active,saved,completed,t3`) returns 282 from any scope, which is
  what the filter field switches to while typing.
- **Renders.** `queue.png` (8 active rows), `completed.png` (6 ghost rows), `t3.png`. Read, not
  just written. Ghost rows drop the status pill and the model, and their hover strip drops save and
  done — the red close appears only on the two rows that still have a tab, which is the `hasTab`
  rule holding in the native row.
- **Transport.** `GET /api/events` emits `data: {"revision":N}`.
- **Guards.** A foreign `Host` on a GET → 403. A POST with a foreign `Origin` → 403. A POST with no
  `Origin` at all → 403 `{"code":"denied"}`, which is worth knowing before reading a rejected curl
  as a broken endpoint.
- **Favicon.** `/api/favicon?dir=<published dir>` → 404 for a directory with no icon; `dir=/etc`
  (never published) → 404 rather than a read.
- **Lifecycle round trip.** `save` then `unsave` on this session (`15342ce9…`), through the server,
  verified in `catalogue.saved`. Restored: `saved=0 completed=0 incognito=0`.

## Found: a scope that outlives its own lifecycle

On two freshly started servers built from master `b0425f0` (ports 8799 and 8801), a session
`unsave`d through that same server stayed in the Saved scope indefinitely — minutes later, with
`snapshotRevision` advancing and the catalogue reading `saved=0`. The resident release on 8787
(`17d8c22`) handled the identical round trip correctly within two seconds, and the only commits
between those two SHAs touch `src/doctor`, `src/launcher` and `src/resume` — nothing in
`src/sidebar`. So this is more likely process state than a code regression: the resident server has
a subscribed client keeping its caches warm, and a young server serving a scope for the first time
right after a mutation apparently caches the pre-mutation projection and never replaces it.

User-visible shape if it is real: save a session, change your mind, unsave it — and it sits in
Saved until the sidebar server restarts. Worth a proper investigation in `read-cache.ts` /
`warm-cache.ts`; not fixed here.

## Not driven

Everything that needs the live panel: context menus, summary popovers, hover, scrolling, the
destroy confirmation, arrow-free `⌘`-badge behaviour, and any coordinate click. All of it is
blocked on the same Screen Recording grant, which requires a human at the keyboard.
