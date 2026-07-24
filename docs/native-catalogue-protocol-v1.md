# Native Claude catalogue protocol v1

CCS owns one on-demand host-local service for the configured Claude projects store. The service is
the source-discovery/index writer; CCS and T3 clients consume metadata through this protocol rather
than scanning JSONL independently or opening `index.db` as a cross-product API.

## Transport and lifecycle

- HTTP/JSON over the Unix domain socket `~/.ccs/run/native-catalogue-v1.sock`.
- `$CCS_ROOT` relocates runtime files; `$CCS_CATALOGUE_SOCKET` can override the socket path. If a
  relocated path exceeds the platform Unix-socket limit, CCS derives a deterministic short,
  per-user socket path under the OS temporary directory; `ccs catalogue-service status --json`
  reports the effective path.
- The run directory is mode `0700`; the socket and lock owner file are mode `0600`.
- No TCP interface is opened.
- `ccs catalogue-service start` starts the daemon on demand. Concurrent starts coalesce behind an
  atomic ownership directory; dead-owner locks and stale socket files are reclaimed.
- The daemon exits after 30 seconds without requests or refresh work by default. Override with
  `$CCS_CATALOGUE_IDLE_MS` or `serve --idle-timeout-ms`.
- `ccs catalogue-service status|stop|refresh` provide explicit supervision. `serve` is the internal
  foreground entry point used by the on-demand client.

Every response contains `protocolVersion: 1`. Clients must reject versions they do not support.
Successful responses and errors are `Cache-Control: no-store`.

## Read endpoints

### `GET /v1/health`

Returns service identity/lifecycle data and the current source status without forcing a scan.

### `GET /v1/source-status`

Returns source generation and freshness. An empty, never-indexed store is refreshed synchronously;
a stale existing snapshot is returned immediately while one coalesced incremental refresh starts.

```ts
interface CatalogueSourceStatus {
  generation: number;                 // changes only when indexed source rows change
  phase: "idle" | "refreshing" | "error";
  freshness: "uninitialized" | "fresh" | "stale";
  indexedAt: string | null;           // snapshot generation time
  refreshedAt: string | null;         // latest successful discovery pass
  ageMs: number | null;
  staleAfterMs: number;               // 5 seconds by default
  rowCount: number;                   // visible root native sessions
  lastError: { at: string; message: string } | null;
  lastRefresh: { scanned: number; parsed: number; skipped: number; removed: number };
}
```

### `POST /v1/root-sessions/query`

Body:

```ts
interface RootSessionQuery {
  query?: string;                     // title, CWD, project name, or native UUID
  cwd?: string;                       // exact recorded source CWD
  cwdPrefix?: string;
  projectRoot?: string;
  activityWindow?: "today" | "7d" | "30d" | "all";
  sort?: "nativeActivity" | "cwd" | "title";
  limit?: number;                     // default 50, maximum 200
  cursor?: string;                    // opaque keyset cursor
  freshness?: "allow-stale" | "require-fresh";
}
```

The result contains `sessions`, `nextCursor`, and `sourceStatus`. Source-row refreshes publish in one
SQLite transaction; generation advances only with the completed snapshot. Cursors bind to the query
filters, sort, activity-window reference time, and source generation. A changed generation or
changed filter returns HTTP 409 `stale_cursor`; restart at page one. Native activity sorts descending, with the
internal indexed session id as a deterministic tie-breaker. CWD and title sort ascending.

Only root, resumable Claude Code sources are returned. Native subagent sidechains, CCS auxiliary
sessions, and non-Claude substrates are excluded.

Rows contain metadata only: provider/host identity, native resume UUID, source CWD, project,
resolved title and title source, branch, first/latest activity, message count, observed size, and
mtime. Native/generated titles are returned; when neither exists, the protocol uses the neutral
`Claude session <uuid-prefix>` rather than CCS's transcript-derived local fallback label. Rows do
not contain source paths, transcript text, preview excerpts, tool payloads, tool results, or
reasoning.

### `POST /v1/source/lookup`

Body:

```ts
{ resumeId: string; cwd: string }
```

This is the attach/continue seam. It requires a UUID, refreshes stale index state, resolves an exact
resume-id/CWD pair, canonicalizes and verifies both CWD and source path, rejects ambiguity and store
escapes, and verifies the current file size/mtime against the indexed snapshot. If the signature
changed during lookup, the authority force-refreshes once and retries.

The result adds the canonical `sourcePath` and `fileIdentity` (`dev:ino`) needed by the owning T3
server's strict attach/sync reader. Consumers must still revalidate the native JSONL before an
attachment or continuation write; this catalogue accelerates discovery, not source integrity.

## Error envelope

```json
{
  "protocolVersion": 1,
  "error": {
    "code": "source_not_found",
    "message": "Claude session was not found in the configured store."
  }
}
```

Expected codes are `bad_request`, `invalid_resume_id`, `invalid_cwd`, `source_not_found`,
`source_ambiguous`, `cwd_mismatch`, `source_changed`, `refresh_failed`, `stale_cursor`, `not_found`,
and `internal_error`.

## Private controls

`POST /_control/refresh`, `POST /_control/title`, `POST /_control/title-failure`, and
`POST /_control/shutdown` are CCS controls on the same user-private socket. They are not part of the
product read protocol. Refresh accepts `{ force: boolean, titles: boolean }`; `ccs reindex` uses it
for source discovery, while the TUI delegates generated-title persistence to the title controls.
This keeps every `sessions`/FTS/status-table mutation behind the daemon's serialized writer lane.
