# Session-hygiene slash commands ship as a user-scope plugin from the repo's own marketplace

Decided with Milad 2026-07-21. Revisits the plugin question that ADR-0020 opened and
ADR-0022 closed — for a different class of resource than the one those ADRs governed.

## The problem: the mechanism exists and nobody uses it

ADR-0010 gave `ccs` the lifecycle mechanism — `idle/parked/completed/archived`, `ccs mark`,
and now `ccs session complete|archive|uncomplete|unarchive`. The verbs have been shipped
and correct for months. Actual usage on this host at time of writing:

| indexed sessions | archived | completed |
|---|---|---|
| 4,663 | 25 | 0 |

The mechanism isn't the bottleneck; the gesture is. Cataloguing a session requires
remembering a CLI verb and leaving the conversation to type it. So history accretes: 4.6k
sessions, effectively none triaged, titles left at whatever the first message implied.

A parallel symptom: four hand-symlinked skills (`session-rename`, `session-retitle`,
`session-tag`, `session-meta`) had already grown in `~/.claude/skills` as thin wrappers over
these same primitives — the ergonomic gap being patched ad hoc, per machine, unversioned,
and with no lifecycle verb among them.

## Decision

Session-hygiene commands ship as a **plugin named `ccs`**, catalogued by a
**`.claude-plugin/marketplace.json` at this repo's root**, with the plugin at
`plugins/ccs/`. Installed at **user scope**, so the commands exist in every session on the
host regardless of cwd.

```
.claude-plugin/marketplace.json     # marketplace: claude-sessions
plugins/ccs/
  .claude-plugin/plugin.json        # plugin: ccs
  commands/*.md                     # auto-discovered → /ccs:<name>
```

v1 commands: `archive`, `complete`, `unarchive`, `title`, `suggest-title`, `tag`, `info`.

`title` and `suggest-title` write the same field through the same call and differ only in who
composes the words — yours verbatim, or generated from the conversation. They stay separate
because those are genuinely different gestures, but they are named for that difference rather
than as `rename`/`retitle`, which described it to nobody. `title` is also the term CONTEXT.md
makes canonical (it lists `name` under *Avoid*) and the verb the CLI already uses
(`ccs session title`).

`suggest-title` generates in the contract from `src/titler/codex.ts` — max 60 characters,
imperative mood, sentence case, no quotes, no trailing period — rather than a style of its own,
so a hand-invoked title is indistinguishable from one `ccs reindex --titles` produces.

This matters because of what `ai-title` actually is. Claude Code writes it into the transcript
as a standalone `{"type":"ai-title"}` record; `ccs` only reads it, as `native_title`, first in
the resolution order. Measured across this host's store: 363 of 4,711 transcripts carry one
(7.7%), and 359 of those 363 never change it — the 4 exceptions are kebab-case worktree names
written into the same field by a different producer, not regenerations. In the session that
prompted this ADR it first appeared at line 16 of 440.

So `ai-title` titles the *opening ask*, once, permanently — frequently the better title, and
already preferred by the resolution chain. `suggest-title` is therefore not a replacement for
it but a drift remedy, and it should decline to churn a title that still fits. Its algorithm is
not reusable: the prompt and model are internal to Claude Code with no API or config surface.
Matching the house contract is the closest available equivalent.

## Why this doesn't contradict ADR-0074

ADR-0074 moved **role** skills and commands to project-level discovery from
`<role-dir>/.claude/`, made `desiredLinksForRoles()` return empty, and reserved the
user-level namespace for "truly global resources (the operator's own skills/commands)."

These commands are that reserved category. A role command is context-scoped by
construction — the scout's commands are meaningful only in a scout session. `/ccs:archive`
is the opposite: it acts on *whatever session you are currently in*, so it must be present
in all of them. Scoping it project-level would make it available precisely where it isn't
needed and absent where it is.

So the two ADRs partition cleanly on scope, not on packaging taste:

- **cluster/role resources** → project-level discovery from the role dir (0074).
- **host-global operator resources** → user scope, and a plugin is how they get there
  without the hand-maintained symlink list that ADR-0020 correctly diagnosed as fragile.

ADR-0020's reasoning about auto-discovery was never wrong; ADR-0022 rejected its *scope*
(per-role distribution), which the role registry handles better. Nothing in 0022 or 0074
argues against a plugin for genuinely global commands.

## Why the marketplace lives in this repo

The commands are a thin skin over `ccs` CLI verbs, so a verb rename breaks them. Colocating
the marketplace with the tool means a CLI change and its command-surface change land in one
commit and version together. A separate plugins repo would let the two drift, which is the
failure mode the whole thing exists to avoid.

The repo is public; the commands are generic wrappers with no vault paths, credentials, or
cluster-private structure. Vault- or Todoist-coupled session skills (`session-park`,
`session-closer`, `session-archaeology`, `session-loop`) deliberately stay out of this
plugin for exactly that reason — they are operator-private and depend on systems `ccs` does
not own.

## `/ccs:archive` semantics: retitle, mark, offer the close

Archiving is a hygiene act, so the command does slightly more than set a flag:

1. **Retitle when the title is stale.** Judged against the conversation itself, not against
   title provenance — a custom title set three hours ago can be just as stale as a native
   one. An archived session with the title `Print CLAUDE_CODE_SESSION_ID variable` is
   hidden but not *organized*; hiding a bad row does not clean history.
2. **`ccs session archive .`** — the per-session verb, never `ccs identity archive`. When
   the session is attached to a core identity, archiving the identity retires the whole
   durable responsibility. Ending one conversation must not retire a standing role. This
   preserves ADR-0010's mechanism/policy split: a session archiving itself is not a cluster
   deciding a responsibility is complete.
3. **Offer the tab close as a confirm link; never self-close.** The command runs inside the
   tab it would be closing, which races its own response and destroys the confirmation
   surface if the wrong session was archived. It mints a `claude-actions cmux-close` link
   instead, and degrades to a plain instruction when that server is unreachable.

## No deletion surface, and no bulk sweep either

Considered and rejected (2026-07-21): a `/ccs:delete`, and a `ccs sweep`/`ccs prune` that
bulk-archives or removes sessions by predicate.

The measurements that decided it, taken on this host:

| | |
|---|---|
| sessions with ≤2 messages and $0 cost ("junk") | 836 of 4,675 (18%) |
| disk those 836 occupy | 34 MB of 2,403 MB tracked (1.4%) |
| largest two individual sessions | 99 MB each |

Deleting the entire junk population would reclaim less than a third of what two real sessions
occupy, so deletion is not a disk story. Nor is it a hygiene story — `archived` already removes
a session from browse, search, and cluster resume, reversibly.

Three further reasons deletion is the wrong shape for a slash command specifically:

- **It cannot act on the current session.** Claude Code holds the transcript open and appends
  every turn; removing `<uuid>.jsonl` mid-session leaves a file the live process keeps writing.
  Every other command here operates on "the session you are in" — delete structurally can't.
- **It inverts the store invariant.** The store is the source of truth and `ccs` never writes
  to it; that is exactly why the index can be deleted and rebuilt at will. A delete path would
  be the first ccs operation capable of destroying data it cannot reconstruct.
- **You are never sitting in a junk session.** They are junk *because* the operator left
  immediately, so an in-session command could never reach them.

A bulk sweep was the stronger of the rejected options — it addresses list clutter rather than
disk, and archiving in bulk is reversible. It was declined as unnecessary for now: hiding is
already one command away, and a predicate that quietly archives 836 rows is a blunt instrument
pointed at history the operator may still want to search. Revisit if browse or search quality
measurably degrades; the FTS index over the skeleton, not the row count, is the thing to watch.

## Consequences

- **Invocation is namespaced** (`/ccs:archive`), per plugin convention. Anything that
  references these by name uses the namespaced form.
- **~282 tokens always-on in every session** across the 7 commands (measured via
  `claude plugin details`). The cost of a command surface being global is that it's global.
  Worth auditing if the set grows much past this.
- **A live session needs `/reload-plugins`** to see newly added commands; new sessions pick
  them up automatically.
- **The four ad-hoc `session-*` skills are superseded** by `/ccs:title`, `/ccs:suggest-title`,
  `/ccs:tag`, `/ccs:info` and should be retired to avoid two commands doing one job.
- **Distribution becomes uniform across hosts.** Any machine gets the current surface with
  `/plugin marketplace add mimen/claude-sessions` + `/plugin install ccs@claude-sessions`,
  instead of per-machine symlinking.
