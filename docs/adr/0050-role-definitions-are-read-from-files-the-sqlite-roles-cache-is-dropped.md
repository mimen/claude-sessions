# Role definitions are read from files directly; the sqlite roles cache is dropped

Follows ADR-0048 (files are the source of truth). Decided with Milad 2026-07-10.

## The decision

Once config files are the source of truth (ADR-0048), a sqlite `roles` cache is a shallow layer
that only ADDS a staleness bug ("edit role.toml, forget to sync, cache lies"). So we DROP the
table entirely rather than keep it as a rebuildable cache.

- **The `roles` table is removed** from the catalogue schema (a migration drops it).
- **`getRoleDef(role)` reads the config files directly**: resolve the role's dir under
  `~/.ccs-config/clusters/*/roles/<role>/` (or standalone `roles/<role>/`), parse its
  `role.toml` (kind + resume_command), derive the rest from position + file-presence
  (skills/commands/hooks membership, home dir). A tiny in-process memo per command invocation
  avoids globbing twice within one `new-session`.
- **The 6 readers** (`sync-roles`, `compose-claude-md`, `hooks-command`, `new-session`,
  `roles-command`, `db`) switch from the sqlite lookup to the file resolver behind the same
  `getRoleDef`-shaped interface, so the blast radius is one function's implementation.
- **`ccs roles ls`** reads the file tree; **`ccs roles upsert`** either writes a `role.toml`
  (creating the package dir) or is retired in favor of "author the files" — TBD in build, but
  the registry-as-mutable-table verbs no longer write an authoritative store.

## Why drop rather than cache

Role reads are not hot — they fire at spawn and SessionStart, not in a loop — and there are ~6
tiny files. A glob + TOML parse is microseconds. A cache would matter only at thousands of
reads/sec. The deletion test: dropping the cache CONCENTRATES correctness (one truth, no drift),
it doesn't move complexity. The cache made sense only while sqlite was the source of truth
(ADR-0022, now superseded).

## Consequences

- Editing a `role.toml` takes effect immediately — no `sync-roles` required for reads to be
  correct. (`sync-roles` is still needed to MATERIALIZE into `~/.claude`, ADR-0051, but that's a
  separate concern from reading a definition.)
- Deletes a whole failure class (stale registry). Supersedes the caching implied by ADR-0022.
