# claude-sessions — vocabulary (session layer)

The core vocabulary the ccs *session layer* uses. This is the narrow surface: browsing,
indexing, and resuming individual Claude Code sessions on one host. For the platform-level
concepts (clusters, roles, work-units, identities, hooks, catalogue), see `docs/CONTEXT.md`
and `docs/GLOSSARY.md`; those layers were built on top of the primitives defined here.

## Language

**Session**:
One Claude Code conversation, persisted as a single `<uuid>.jsonl` file under the Store.
Identified by its session ID (a UUID). The unit the tool browses and resumes.
_Avoid_: chat, conversation, thread.

**Store**:
The single directory `~/.claude/projects/` where Claude Code centralises every Session
on a host. The only place sessions live — they are never written into project repos.
_Avoid_: sessions folder, history.

**Host**:
A machine that runs Claude Code and therefore has its own Store. The tool operates on
exactly one Host (the local one); every indexed Session is tagged with its Host so a
synced index stays unambiguous about origin.
_Avoid_: machine, device, computer (when referring to the session-origin tag).

**Index**:
The rebuildable SQLite cache of Session metadata that backs the tool's browse and search.
A pure cache: deleting it loses nothing, since it is fully reconstructable from the Store.
Refreshed incrementally — only Sessions whose file changed are re-parsed.
_Avoid_: database, cache, catalogue (catalogue is reserved for the future tagging layer).

**Title**:
The short, human-readable name shown for a Session in the browse list. Resolved in priority
order: the Session's native Claude Code `ai-title` if present, else an LLM-generated title
(Codex), else the cleaned first user message. Cached in the Index. Distinct from a Session's
UUID (its identity).
_Avoid_: label, name, summary.

**Native Title**:
The `ai-title` Claude Code itself writes into a Session file. Free and already present for
Sessions created by recent Claude Code versions; the preferred Title source when available.
_Avoid_: ai-title (in prose), CC title.

**Project**:
The grouping a Session belongs to: the git repository root containing its `cwd`. When the
`cwd` is not inside a repo, or no longer exists on disk, the Project is the `cwd` itself.
Note this is coarser than Claude Code's own per-`cwd` storage grouping — sessions run from
a repo's root and its subdirectories collapse into one Project here.
_Avoid_: directory, folder, cwd, workspace.

**Resume**:
The core action: re-entering a chosen Session as a live `claude` process in the Session's
recorded `cwd`. Resuming *in place* continues the original Session; *forking* starts a new
Session from it, leaving the original untouched.
_Avoid_: open, restore, reopen, continue.

**Resume Target**:
Where a Resume lands. *Inline* hands the current terminal to `claude`. *cmux* opens a new
cmux Workspace named after the Session's Title and runs the Resume there. The target is
chosen automatically based on whether cmux is reachable, and can be overridden.

**Workspace**:
A cmux workspace — the named, focusable terminal surface cmux opens for a Resume. Belongs
to cmux's domain, not this tool's; the tool only creates and names them.
_Avoid_: using "workspace" to mean a Project, a tab, or a window.

**Cost**:
A Session's API-equivalent USD spend, summed from the exact billed `usage` fields on the
transcript's assistant lines × per-model list pricing (input/output, cache read at 0.1×,
5-minute cache writes at 1.25×, 1-hour cache writes at 2×, web searches at $10/1k).
Derived data: computed during reindex, stored in the Index (never the catalogue), and
recomputed whenever the file changes. On a subscription it is notional, not an invoice —
the metric for comparing Sessions and loops. Subagent runs are separate Index rows; the
`ls` column and `tree` Σ roll them up into their parent.
_Avoid_: price, bill, spend (when referring to the stored per-Session number).
