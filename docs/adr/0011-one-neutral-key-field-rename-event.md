# One neutral key field per session (rename ccs `event`); the value is the system's storage key

Working through PR identity, Milad caught a double standard: I'd argued a `pr_number`
column would leak pr-watch's domain into ccs, while treating `event` as clean —
but `event` (ccs commit d82d079) leaks EVENT-WATCH's domain exactly the same way.
Its name lies for a PR session. And the whole thread just taught us a misleading
name (constellation) causes real confusion.

His synthesis (2026-07-08): don't add a PR column and don't keep the misnamed
`event` — have ONE stable key that IS the identity, and let each system fill it with
its own storage key. pr-watch ALREADY keys its local storage on exactly this string:
flat_key(repo,num) = "heroku_dashboard-12113", and its files are literally
pr-heroku_dashboard-12113.judgment/result.json. So one key already serves three
roles we never named together: identity ("what is this session"), storage pointer
("where its local state lives"), and domain reference ("which PR").

Decision:
- ccs has ONE domain-neutral key field per session (rename `event` -> a neutral
  name). ccs treats it as an OPAQUE string; it does not know it's a PR or an event.
- Each SYSTEM fills it with its own storage key: pr-watch -> the PR key
  (heroku_dashboard-12113, which already names its files); event-watch -> the event
  slug (which already names events/<slug>/). No pr-watch-specific column in ccs.
- A session "identifies its storage" by reading this one key off its catalogue row.
- This is DURABLE IDENTITY set at spawn by the control plane; it does NOT change
  when a session's live cwd/branch wanders (cwd is verified mutable — parsed
  per-message from the transcript, and a session need not live in its worktree
  forever). The written key is authoritative; the cwd/branch PR-sense (ADR-0011-era
  option A) only REFRESHES live status for the session whose key matches, never
  re-binds identity.

Naming: rename ccs `event` -> a neutral field. Candidates slug/key/ref; pick at
implement time. Blast radius: touches event-watch's setEvent/sessionsForEvent +
a small catalogue migration (additive rename, back-compat read of old `event`).

CROSS-MACHINE MIGRATION (Milad's explicit ask): event-watch + ccs run on ANOTHER
machine too. Once this rename lands, migrate the other computer's ccs catalogue +
event-watch to the updated reality (neutral field name, back-compat read), so the
two machines don't diverge. Track this as a required follow-up of the rename, not
optional.

Supersedes the `event`-slug framing in ADR-0006 and ADR-0009: wherever those say a
worker carries an `event` slug, read it as "the neutral key field, value = the PR
key." Their substance (durable identity, real-spawn-only parent edges, system
grouping) is unchanged.
