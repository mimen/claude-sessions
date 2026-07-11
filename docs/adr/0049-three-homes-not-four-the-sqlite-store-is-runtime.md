# Three homes, not four: the SQLite store is RUNTIME and lives under ~/.ccs

Amends ADR-0041 (three homes) — which the code violated with a fourth. Decided with Milad
2026-07-10.

## The problem

ADR-0041 names three homes (TOOL / CONFIG / RUNTIME) each with one responsibility. But the
tool's durable SQLite lived in a FOURTH, unaccounted location — `~/.claude-sessions/`
(`catalogue.db`, `index.db`, `skills.db`, `config.toml`, `prefs.json`) — and `catalogue.db` was
internally MIXED: runtime tables (`catalogue`, `session_tags`) alongside DEFINITION tables
(`roles`, `epics`) that duplicated the config tree. Neither the three-homes contract nor the
"definitions are versioned in one git repo" promise held.

## Decision — collapse the fourth home into ~/.ccs (runtime)

- **`~/.claude-sessions` is retired.** Everything in it is runtime or derived, so it moves under
  `~/.ccs`:
  - `index.db`, `skills.db` — pure rebuildable caches of the Store (CONTEXT.md already says so)
    → `~/.ccs/cache/`.
  - `catalogue.db` — session state (`catalogue`, `session_tags`) → `~/.ccs/cache/` (or a runtime
    subdir); its DEFINITION tables (`roles`) are dropped (ADR-0050) and (`epics`) demoted to
    cluster runtime state (ADR-0039-amended).
  - `config.toml`, `prefs.json` — tool preferences → `~/.ccs`.
  - the `sync-roles` materialization manifest → `~/.ccs`.
- **Each home now has exactly one responsibility** (ADR-0041 restored):
  - `~/projects/claude-sessions` — the TOOL (code), no user state.
  - `~/.ccs-config` — DEFINITIONS (source of truth), git, self-contained cluster packages.
  - `~/.ccs` — RUNTIME + derived (state, inboxes, caches). Never git.
- **A migration moves the existing dbs + files** and repoints `paths.ts` (the 16 importers read
  from there, so the change is localized to one module).

## Consequences

- No definition data hides in a runtime db; deleting `~/.ccs` wipes all state + caches and loses
  nothing that isn't rebuildable or re-sensed.
- `paths.ts` becomes the single seam for the runtime root (honoring `$CCS_ROOT`/`$HOME` per the
  earlier fix), so tests never touch the real home.
- Amends ADR-0041: it named three homes but the store was a silent fourth; now it truly is three.
