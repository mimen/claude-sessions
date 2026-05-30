# Review

## Findings

- [High] `locateLaunchDir` can choose the wrong working directory for colliding encoded paths. Claude's storage-folder encoding is lossy (`/a-b` and `/a/b` both encode the same), but `resolveResumeCwd` always trusts `locateLaunchDir(row.path)` before considering the recorded `row.cwd` (`src/resume/command.ts:42`). The decoder walks from `/` and returns the first matching directory it happens to encounter (`src/resume/locate.ts:35`), and the advertised round-trip guard is a no-op because both branches return `decoded` (`src/resume/locate.ts:66`). If the recorded cwd still exists and encodes to the storage folder, prefer it; only then fall back to filesystem decoding. If decoding is kept, reject non-round-tripping candidates and surface ambiguity.

- [High] The filesystem decoder is an unbounded synchronous walk from root on every resume. `decodeStorageFolder` starts at `/` (`src/resume/locate.ts:28`) and calls `readdirSync` for every matching prefix candidate (`src/resume/locate.ts:35`). On a real macOS machine this can traverse slow mounts, protected directories, large home trees, or cloud-synced folders, freezing the TUI on Enter. This logic should be bounded to plausible roots from the storage folder/recorded cwd/home, cached, or moved out of the hot interactive path with a timeout and visible failure.

- [Medium] A single unreadable or disappearing transcript aborts the entire reindex. `reindexStore` calls `parseSessionFile` without a per-file `try/catch` (`src/index/index.ts:107`), and `parseSessionFile` creates the read stream directly (`src/parse.ts:88`). If a file is pruned, permission-denied, or truncated between scan and parse, the whole command/TUI launch can fail instead of skipping one bad file and reporting it. Treat per-file parse/open failures like corrupt JSON lines: count them as skipped/failed, keep indexing the rest, and preferably remove stale rows for vanished paths.

- [Medium] Inline resume crashes when `claude` is missing or cannot spawn. `handoffInline` calls `Bun.spawnSync(cmd.argv, ...)` without catching spawn errors (`src/resume/inline.ts:8`). Bun throws for a missing executable, so pressing Enter can terminate `ccs` with a stack trace instead of a useful message. `cmux` and `codex` paths already catch spawn failures (`src/resume/cmux.ts:8`, `src/titler/codex.ts:58`); inline resume needs the same treatment.

- [Medium] Background titling is not cancellable and can write to a closed DB after the TUI exits. The effect starts `backfillTitles` and only flips an `alive` flag to suppress React state updates (`src/tui/App.tsx:99`). The workers still call `saveCodexTitle`/`recordTitleFailure` after each Codex process returns (`src/titler/queue.ts:38`), while `launchTui` closes the database immediately after `waitUntilExit` (`src/cli.ts:130`). A quick quit/resume during title generation can race into writes on a closed handle. Add cancellation/abort support, await drain before closing, or keep background titling out of the interactive process.

- [Low] TUI launch silently ignores store scan failures and opens stale or empty data. The headless `reindex` command prints scan errors, but `launchTui` does `if (scan.ok) await reindexStore(...)` with no else branch (`src/cli.ts:119`). A bad configured store path, permission issue, or missing `~/.claude/projects` looks like "No sessions indexed yet" or stale history. Surface the scan error in the TUI/status line and consider returning non-zero on first run.

- [Low] Search ranking in `search()` does not match its comment. The SQL subquery orders FTS hits by `rank`, but the outer query reorders everything by recency (`src/index/index.ts:265`). The current TUI mostly uses `ftsMatchIds` plus fuzzy ranking, so this is not the main UI path, but any caller of `search()` gets recency, not ranked FTS results. Either remove the misleading rank claim or join against the FTS result and order by rank intentionally.

- [Low] Skeleton tail de-duplication drops repeated turns, not just overlapping turns. `buildSkeletonText` builds a set of first-turn text and removes any last-turn text with the same string (`src/parse.ts:178`). In sessions with repeated short messages like "ok", "continue", or repeated tool stubs, the recent tail can disappear even when those are distinct later turns. Track positions/counts instead of string identity if the goal is only overlap avoidance.

- [Low] Manual re-title has no rejection handling. `retitle` fires `titler.generate(...).then(...)` and assumes the promise resolves (`src/tui/App.tsx:188`). The current Codex titler catches internally, but the `Titler` interface does not require that behavior; tests/mocks or future titlers can reject and produce an unhandled promise rejection. Wrap it in `try/catch` or normalize failures in the caller.

## Process-Safety Notes

- `buildResumeCommand` uses argv for inline Claude, which avoids shell injection for direct resumes (`src/resume/command.ts:21`). The cmux path necessarily passes a shell string, but `shellQuote` covers spaces and single quotes (`src/resume/command.ts:31`). The remaining risk is operational: cmux will run whatever `claude` resolves to on PATH, and failures are reduced to `false` with stderr discarded (`src/resume/cmux.ts:8`).

- The Codex titler is reasonably contained: no shell invocation, read-only sandbox, ephemeral mode, user rules/config ignored, and a timeout (`src/titler/codex.ts:40`). It still sends transcript skeletons to Codex by design, so any privacy expectation should be documented as "session excerpts leave the machine when titling is enabled."

## Test Gaps

- Add resume-location tests for encoded-path collisions: existing recorded cwd encodes to the folder, but `decodeStorageFolder` can find a different path first. This targets `src/resume/command.ts:42` and `src/resume/locate.ts:35`.

- Add tests for `locateLaunchDir` rejecting round-trip failures or ambiguity; the current "sanity" branch is not actually tested and cannot fail (`src/resume/locate.ts:66`).

- Add reindex tests where a scanned file disappears or is unreadable between `scanStore` and `parseSessionFile`; the current path has no per-file recovery (`src/index/index.ts:107`).

- Add spawn-failure tests for inline `claude`, matching the existing defensive behavior of `cmux`/Codex (`src/resume/inline.ts:8`).

- Add lifecycle tests around TUI exit during an in-flight title generation, or refactor title backfill so it can be tested with an abort signal (`src/tui/App.tsx:99`).

## Prioritized Top 5

1. Fix resume cwd resolution to prefer an existing recorded cwd that encodes to the storage folder, and handle lossy encoding collisions explicitly.
2. Replace the root-wide synchronous decoder with a bounded/cached strategy that cannot freeze the TUI.
3. Make reindex resilient to per-file transcript open/parse failures.
4. Add error handling for missing/unspawnable `claude` in inline resume.
5. Add cancellation or shutdown coordination for background titling before closing the SQLite DB.
