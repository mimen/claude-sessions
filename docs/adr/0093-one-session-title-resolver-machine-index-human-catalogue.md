# One session-title resolver; generated titles in the index, human choices in the catalogue

Decided with Milad 2026-07-22, implementing the plan in `docs/plans/titling-audit.html`. That
audit found the session-title machinery worked but had accreted: ~7 surfaces each decided a
Session's display title independently and had drifted, a human retitle wrote rebuildable storage,
and a misnamed field misled readers. This ADR is the fix, scoped deliberately to the *one-off
session title* and leaving the *identity/cluster naming* domain untouched.

## The two naming domains (scope)

There are two distinct kinds of "title," and this change touches only the first:

- **Session title** — "what was this conversation about?" — for ordinary one-off sessions.
  *Generated* (native / codex / fallback) plus an optional *human* override. IN SCOPE.
- **Identity name** — "which durable responsibility is this?" — for role loops and cluster
  work-units (pr-watch, event-watch). *Authored*, never generated; owned by `render-tab.ts`,
  the statusline, and cluster `catalogue_sync`. OUT OF SCOPE, unchanged.

The code already half-embodied the split: `render-tab.ts` is the identity renderer, and a plain
session never routes through it. This ADR makes the boundary explicit rather than merging the two.

## Decision

### 1 · One canonical resolver (`src/title.ts`)

`resolveSessionTitle()` is the single place a Session's display title is decided. Precedence,
highest first:

```
live → custom → role → native → codex → fallback
```

`live` is the cmux tab title right now (TUI only; feeds `custom` via the write-through). `custom`
is the human's deliberate choice. `role` is the identity name (present only for identity sessions,
so a plain session's chain is just `custom → native → codex → fallback`). `native/codex/fallback`
is the generated tail resolved from the Index.

Every session-title surface calls it: `ccs ls`, the TUI list, the preview, `ccs meta`,
`ccs session`. They can no longer drift, and the source that *won* is returned alongside the title
so the `★/✎/~` glyph and the preview's source label reflect reality instead of only the Index
COALESCE (a custom title no longer prints as `★ native`).

The identity domain is deferred to, not swallowed: for an identity session the resolver yields the
`role` name; the tab/statusline renderers keep their own authored-name logic.

### 2 · Provenance invariant — machine→index, human→catalogue

*Generated guesses live in the rebuildable Index; authoritative human choices live in the durable
Catalogue.* Concretely, the TUI `t` key now writes `custom_title` (durable) and syncs the cmux tab
— identical to `ccs rename` — instead of `saveCodexTitle` (the Index, lost on a rebuild and shadowed
by any native title). `codex_title` becomes purely the automated-backfill field.

### 3 · `native_title` documented, not renamed

The field holds the session's *last-emitted* title — the harness's `ai-title` initially, but
overwritten by external renames (e.g. cmux worktree slugs). It is documented as such at the parse
site and column, so no reader assumes it is always AI prose. A rename to `harness_title` was judged
not worth the codebase-wide churn for a cosmetic gain.

## What this fixes

- **F1** — `ccs meta` / `ccs session` showed only `custom_title` (blank for native/codex/fallback
  names). They now show the resolved title.
- **`ls`-vs-TUI drift** — `ls` lacked the `role` layer the TUI had. Both now share the resolver.
- **F2** — the `t` key wrote `codex_title` while `/ccs:suggest-title` wrote `custom_title`. Both are
  `custom_title` now.
- **F3** — a `codex_title` from `t` was shadowed by any native title, so `t` silently no-op'd on
  native-titled sessions. A `custom_title` outranks native, so `t` works on every session.
- **G1** — the source glyph reflected only the Index COALESCE and lied when a custom title showed.
  It now reflects the resolved source.
- **N1** — `native_title`'s meaning is documented.

## Explicitly out of scope

- **Single-writer `custom_title` (the deferred "P3").** The cluster `catalogue_sync` also writes
  `custom_title`, which spawned `meta.shortname`, `stripPrPrefix`, and the write-through slug-guard.
  Retiring those requires giving the synced PR title its own field — a change that crosses into
  `~/.ccs-config` (the sync writer lives there, not this repo). It is a separate, cross-system track.
  Within the one-off domain, `custom_title` already has a single writer (the human), so nothing here
  depends on that cleanup.
- **Search over custom titles.** The FTS index (in `index.db`) covers `native/codex/fallback`; a
  `custom_title` (in `catalogue.db`) is not FTS-matched, so searching for a name you typed won't hit
  it. Cross-database FTS is a separate enhancement; display precedence is unaffected.

## Consequences

- New leaf module `src/title.ts` (no dependencies) imported by `index.ts`, `cli.ts`, `App.tsx`.
- `SessionRow.titleSource`'s type widened to the display union (`live|custom|role|native|codex|
  fallback`); the Index SQL still only produces `native|codex|fallback`, so reads are a subset.
- `titleOf()` now delegates to a new `indexTitleOf()`; `resolvedTitleOf()` added for the command
  surfaces. No schema change, no data migration — past `t`-key `codex_title` writes remain valid
  generated titles, simply outranked by any `custom_title`.
- The identity naming subsystem (`render-tab.ts`, statusline) is untouched.
