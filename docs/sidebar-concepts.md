# Sidebar concepts — the chunks, and where each kind of bug lives

The native sidebar is five layers. Every bug observed so far localizes to exactly one of
them, so when something looks wrong, walk this list top-down and check each layer's truth
against the next one's. The probe commands under each chunk are the fastest way to say
"this layer is fine, look deeper".

## 1. cmux bridge — what is actually running

`src/cmux/live.ts`, `src/cmux/events.ts`, the hook store (`~/.cmuxterm/claude-hook-sessions.json`).

Truth: which workspaces exist, which is active, which session id each surface is bound to.
Read via `cmux tree --all --json --id-format both` plus the hook store; changes stream in
over `cmux events`.

Failure shapes that belong here: a workspace bound to a stale or wrong session id (the
upstream hook-store resume-binding bug), the event stream dying silently (server falls
back to timed reads and logs `cmux event stream unavailable`), the socket moving on a
cmux update.

Probe: `cmux tree --all --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["active"])'`

## 2. Stores — what CCS knows durably

Catalogue (`~/.ccs/cache/catalogue.db`, `src/sidebar/catalogue-read.ts`) and index
(`~/.ccs/cache/index.db`, `src/index/`).

Truth: session identity (canonical id vs resume aliases), lifecycle, titles, enrichment,
model. The catalogue's `canonicalSessionIds` map is the authority on "these ids are the
same session"; the index supplies transcript-derived detail. The resident sidebar probes
SQLite file identity and `PRAGMA data_version` once a second, without loading rows, so commits
made by another CCS process enter the same revision stream as cmux changes.

Failure shapes: a live session the stores have not admitted yet (fresh context-limit
continuation → shows as a second, sparsely-detailed row until the catalogue refresher
records the resume link), alias chains the index knows under different ids than the
catalogue, unreadable stores (server degrades to live rows and says so).

Probe: `sqlite3 ~/.ccs/cache/index.db "SELECT session_id, resume_id FROM sessions WHERE session_id='<id>' OR resume_id='<id>';"`

## 3. Server caches + projection — the merge

`src/sidebar/change-monitor.ts`, `snapshot.ts`, `projection.ts`, `read-cache.ts`,
`warm-cache.ts`, `liveness-cache.ts`, `status.ts`, `workspace-state.ts`, `notifications.ts`.

Truth: the rows the API serves. The change monitor combines cmux frames with durable SQLite
commit probes behind one source revision. Liveness reads await freshness on invalidation and
fail closed after 15s; warm caches serve stale-while-revalidate and announce replacements;
every source revision invalidates all serialized query variants before SSE announces it.
Projection joins layers 1 and 2 — canonical-id
collapse, alias dedupe, glyph stripping, section assignment — and its output ids are what
every action endpoint receives back.

Failure shapes: stale focus/status that outlives an invalidation (cache bug), duplicate
rows for one session (collapse miss), an id served in a row that an action endpoint then
refuses (projection and action resolution disagreeing about identity).

Probe: `curl -s 'http://127.0.0.1:8787/api/snapshot?limit=2000&scope=active&include=saved' | python3 -m json.tool | less` — and compare `focused` with layer 1's active workspace. When quoting ids from this, never truncate them: several live sessions share long id prefixes.

## 4. Transport — how the client hears about it

Server: SSE `/api/events` + revision-stamped snapshots. Client: `SnapshotClient.swift` — SSE
follow with backoff, 1s poll disconnected / 5s poll connected, a five-second request timeout,
refresh-generation guard against out-of-order responses, and `refreshNow` after every action.
A snapshot older than the announced revision is retried once and never replaces newer rows;
a failed refresh leaves that revision pending for the backstop poll.

Failure shapes: the extension polling a dead port (the port-8788 staging misbuild), SSE
zombie connections (poll backstop bounds the damage at 5s), or a snapshot request timing out.
None requires a remount: both loops retry and pending revisions survive request failure.

Probe: `tail ~/Library/Containers/com.milad.ccs.sidebar.Extension/Data/Library/Caches/ccs-sidebar.log` — look for "connected to port 8787".

## 5. Native client paint — what the pixels say

`SessionListView.swift`, `SessionRowView.swift`, `SidebarRootView.swift`,
`PointerWatch.swift`.

The rule this layer lives by: **derived, never accumulated.** Row data is whatever the
last snapshot said. Hover is recomputed ~30×/s by hit-testing the pointer's polled
position (`PointerWatch`, a window-server query — not AppKit enter/exit events, which
ExtensionKit drops on workspace reattach) against row frames measured this layout pass.
Focus paint is snapshot truth plus a 4-second optimistic override set by a click,
retired on confirmation or expiry. Recreating the view must yield the same screen as one
that has run for a day; any state only a remount can reset is a bug in this layer by
definition.

Failure shapes: anything "stuck" — a highlight, a popover, a tint — that a close/reopen
cures. That signature always means some state here is event-accumulated again.

Probe: screenshot the panel and diff against layer 3's `focused` — one lit row, and it
must match the server (or a click within the last 4 seconds).

## The one diagnostic rule

"Correct at mount, drifts with uptime" means either layer 4 stopped carrying revisions or
layer 5 accumulated presentation state; compare the API before remounting to distinguish them.
"Wrong immediately and consistently" is layers 1–3 disagreeing — find the pair of adjacent
layers whose probes contradict each other. "Wrong for more than the five-second backstop after
a change" is a transport defect, not an acceptable cache window.
