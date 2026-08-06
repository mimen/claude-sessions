# CCS productivity sidebar

A work queue for the cmux Dock: what needs you, what is running, what is ready, and what you
might resume. It answers one question — what deserves attention next — and deliberately leaves
out cost, lineage, roles, and catalogue metadata, which never change what you do in the next
thirty seconds.

## Run it

```sh
bun run bin/ccs sidebar serve     # http://127.0.0.1:8787/
bun run bin/ccs sidebar url       # print the URL without starting anything
```

The port is fixed by default so the Dock can hold a stable URL across restarts. `--port` and
`--host` override it, but `--host` accepts only a literal loopback address (`127.0.0.0/8` or
`::1`); anything else is refused rather than silently exposing your sessions to the network.

## Put it in the Dock

Start the server first, confirm the page loads, then add it as a Dock browser surface:

```sh
cmux new-pane --type browser --placement dock --url http://127.0.0.1:8787/
```

Dock configuration is not written by this repository. cmux restores its own saved Dock layout,
so a `~/.config/cmux/dock.json` entry only seeds an initial layout and may be ignored once a
snapshot exists.

Alternatively, install the URL as its own custom sidebar and let cmux open it:

```sh
bun run cmux:sidebar:install:web    # ~/.config/cmux/sidebars/ccs-web.url
cmux sidebar open ccs-web
```

That artifact is versioned at `integrations/cmux/sidebars/ccs-web.url` and installs under its own
name, so it neither replaces nor outranks the interpreted `ccs.swift` navigator; both can be
present and cmux decides which is active. It refuses to overwrite a differing installed URL unless
`bun run cmux:sidebar:install:web:force` is used, which first backs the old one up.

## The row

```
[icon] claude-sessions                          ● Running
Design the productivity sidebar
cmux-t3-sidebar-v1                       Sol ⬡  2m
```

- **Top left** — the project, with its own favicon when it publishes one. This is the
  repository's name, so every worktree of one repository reads as the same project.
- **Top right** — cmux's `claude_code` status, reproduced verbatim with cmux's own colour. The
  sidebar never invents a status.
- **Middle** — the session name, with cmux's activity glyph stripped since the pill already
  says that.
- **Bottom left** — which checkout, shown only when the session is in a linked worktree.
- **Bottom right** — the model's short name with its provider's own logo, then time since the
  last recorded activity.

Sections come from cmux's own status words: `needs input` → **Needs you**, `running` →
**Working**, anything else live → **Ready**. Sessions that are not live fill a small **Recent**
shelf. Within a section, cmux's ordering is preserved so rows never jump mid-turn.

## Clicking a row

One action, decided on the server: focus the workspace when the session is live, resume it
through CCS when it is not. The browser never chooses between them, because choosing wrong
spawns a duplicate of a running session. When cmux state is unreadable the sidebar says so and
refuses to resume anything.

### The native focus bridge

Hosted inside cmux's own web view, the page can skip the HTTP round trip for the most common
click of all — "show me that tab". `web/focus-bridge.ts` posts one versioned message and waits at
most a second:

```
window.webkit.messageHandlers.cmuxSidebarFocusWorkspace
  .postMessage({ v: 1, workspaceId })      →  { v: 1, status: "focused" | "not-found" | "unavailable" }
```

Only a row that has a workspace is ever offered to the bridge; a sessionless-but-workspaceless row
has no native address, so it goes straight to HTTP without a message.

A reply is read exactly, not leniently. It must be a plain object — not an array — whose own keys
are precisely `v` and `status`, with `v === 1` and the status one of those three. **Extra keys are
a rejection**, because the fields a host would grow are the ones that change what the reply means:
a capability list, an error detail, a partial focus. Reading `focused` out of such an envelope and
discarding the rest answers a question that was not asked. A host that adds a field bumps `v`;
until then the unfamiliar shape falls through to HTTP, which is always correct and merely slower.

`focused` is the only outcome that ends the action, and it costs zero requests. Every other
outcome — `no-bridge` (an ordinary browser tab, or a cmux without the handler), `not-found`,
`unavailable`, `rejected`, `timeout`, `malformed-reply` — falls through **exactly once** to the
same request as before: `/api/open` for a session row, `/api/workspace/focus` for a workspace row.
The list re-reads afterwards either way. The bridge is therefore pure latency: it can never be the
reason a click fails, and it changes nothing about what the page can reach or what the server
believes.

## What the browser can reach

Three endpoints, and nothing else:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/snapshot` | The projected rows. No file paths beyond the session's own directory, no transcripts, no database handles. |
| every request | The `Host` header must match the bound address, so a rebound DNS name cannot read the queue. |
| `POST /api/open` | Focus or resume one session id. Requires an `Origin` matching the address actually bound; a missing or foreign one is refused. |
| `GET /api/favicon?dir=` | Only a directory the latest snapshot published, and only the raster icon already found inside it. Symlinks are refused, the file is re-opened without following one, and the response carries `nosniff` plus a locked-down CSP. SVG is excluded outright, since a top-level navigation would run it as a same-origin document. |

## Modules

| File | Responsibility |
| --- | --- |
| `projection.ts` | Pure projection: sections, row anatomy, model identity, name cleaning. No I/O. |
| `catalogue-read.ts` | Query-only catalogue adapter. Opens SQLite readonly and preserves the catalogue hydration contract needed by snapshots. |
| `index-read.ts` | Query-only transcript-index adapter. |
| `read-cache.ts` / `warm-cache.ts` | Reuse readonly handles and the latest complete snapshot without placing writers in request code. |
| `status.ts` | Parsing and bounded reading of cmux's `claude_code` status. |
| `worktree.ts` | Resolving a directory to its project and, if linked, its worktree. |
| `favicon.ts` | Finding a project's icon in conventional locations. |
| `snapshot.ts` | Builds normalized snapshots and exact ETags over the adapters above. |
| `session-action-coordinator.ts` | Runs focus/resume and mutation actions outside snapshot construction. |
| `server.ts` | The loopback host and conditional-GET transport. |
| `bundle.ts` | Builds the browser bundle at startup, so the served page always matches source. |
| `web/focus-bridge.ts` | The optional native focus handler, and the single fall-through to HTTP when it does not focus. |
| `web/` | The React app. Typechecked by its own project (`bun run typecheck:web`). |

The import boundary is deliberate: sidebar request modules may use readonly query adapters, but may not
import `catalogue/db-mutations.ts`, call `openCatalogue`, construct a writable SQLite handle, or issue raw
catalogue mutation SQL. `catalogue/mutation-boundary.test.ts` enforces this.

## Limits

The page polls every four seconds. Unchanged polls use the snapshot ETag and return an empty `304`; changed
snapshots are built asynchronously and served from the centralized warm cache. There is no push transport;
the UI shows what the last complete snapshot said and labels unreadable sources rather than implying
freshness it does not have.

This is separate from the interpreted Swift sidebar in `integrations/cmux/`, which remains the
compact left-sidebar navigator.
