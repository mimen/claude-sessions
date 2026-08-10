# Destroy resolves a manifest and closes live workspaces before it deletes anything

Decided 2026-08-09.

## Context

Every other lifecycle verb in ccs is additive or reversible. `complete` and `archive` set a bit and explicitly leave the transcript alone; the catalogue is durable metadata precisely so it survives an index rebuild. Nothing in the tool removed a session, so nothing in the tool had to reason about partial removal.

A session's physical footprint is larger than its transcript and is not derivable from its cwd. The index's `shadow_paths` is the only record of duplicate transcripts left behind when a session moved worktrees. Subagent sidechains live in a directory named for the parent session, beside its transcript. Task state, edit history, and session env live under `~/.claude`; enrichment and self-check logs live under the ccs runtime root. A destroy that reconstructs paths instead of reading them misses the copies.

The failure this has to prevent is a half-destroyed session: gone from the listings, still on disk. A running `claude` owns its transcript and re-flushes it every turn, so unlinking underneath a live process produces a resurrected file and a destroy that quietly did not happen.

## Decision

`ccs session destroy` follows the ccs preflight convention (bare invocation inspects, a flag mutates) with one tightening: the flag is `--confirm <session-id>` and the id must be retyped in full. A bare `--yes` is a single token an agent can append to the command it just printed; retyping the id is a second independent act of naming what dies.

Execution order is the contract:

1. Resolve the full manifest — the subtree via a breadth-first walk of `parent_session_id` with a visited set, since nothing in the schema prevents a cycle.
2. Close every live workspace. **A single close failure returns an error having deleted nothing.**
3. Delete files and directories.
4. Delete catalogue rows in one transaction, detaching any surviving child that pointed at a destroyed parent.
5. Delete index rows, the `sessions_fts` entry, and the `catalogue_hidden_sessions` entry.

Rows go last so that a process death mid-run leaves the catalogue pointing at the wreckage rather than forgetting it existed. The FTS row is deleted explicitly because it is only cleaned during a reindex, so a destroyed session would otherwise still answer a search until the next one.

Destroy does not remove identities, cmux's logs, or the ccs backups. An identity outlives its sessions by design and may be shared; rewriting an append-only file another process holds open risks corrupting it; and the backups exist precisely to survive a mis-aimed destroy, for every *other* session. These are reported in the manifest so the command's output is never read as a stronger guarantee than it can make.

The `/ccs:destroy` slash command prose forbids running the `--confirm` form in the same turn as the preflight, even though the preflight prints the exact command. The two steps exist so a human reads the manifest between them.

## Consequences

- A destroy either completes or changes nothing. The abort path is tested against a fixture store with an uncloseable live workspace, asserting every path still exists.
- Destroying a session that is currently open closes its own workspace first. For `ccs session destroy .` this means the caller's workspace.
- `src/catalogue/destroy.ts` joins the ADR-0068 sanctioned-mutation allowlist, so its deletion primitives (`deleteSessionRows`, `detachChildrenOf`, `clearEnrichment`) live in `db-mutations.ts` with every other raw catalogue write.
- Backups are the only recovery path, and they are per-store rather than per-session. A user who destroys the wrong session restores a whole catalogue or nothing.
