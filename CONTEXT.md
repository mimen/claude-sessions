# claude-sessions

A single-machine TUI (`ccs`) for finding and resuming any Claude Code session on the
current host, regardless of which directory it was started in. Foundation for a later
session-cataloguing layer.

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

**Role**:
The durable fleet grouping node a Session can be a body of. Role definitions live in the vault
(`ClaudeConfig/roles/`); the catalogue stores only the name (the role edge, v5). A role's
Sessions are its bodies in succession — the role persists while bodies come and go.
_Avoid_: loop, agent, identity (different edge).

**Substrate**:
The agent runtime a Session ran on. Defaults to `claude-code` (stored as unset); arbitrary
values accepted (`codex`, `engine`, …) so the catalogue stays substrate-neutral as the fleet
grows beyond Claude Code.
_Avoid_: platform, engine (that's one substrate's name).

**Identity**:
The launching identity — the `CLAUDE_IDENTITY` value the launcher alias exported into the
Session's environment (issue 64's registry). Records *which `claude-<name>` started this
Session*; distinct from Role (a workspace identity like `auf` is not a fleet role). A session
can self-stamp with `ccs identity`.
_Avoid_: launcher (the alias), role.

**Lineage**:
A Role's bodies in succession order (first activity ascending). `ccs lineage <role>` lists
them; `--search` full-text-searches the actual transcript files of the whole set, so any body
can search everything its predecessors said and did.
_Avoid_: history, ancestry.

**Merged View**:
The fleet-wide catalogue: one derived SQLite file unioning every Host's catalogue + an Index
snapshot per session, with an authoritative owning Host per row (owner = whose Index holds the
transcript; the owner's catalogue row wins conflicts). BUILT only on the Merge Host
(`ccs merge`, from the replicas replicate.py delivers), PULLED elsewhere (`ccs merge --pull`),
read via `ccs ls --fleet`. Purely derived and rebuildable, like the Index — never synced,
never a source of record.
_Avoid_: fleet db, global index, merged catalogue (it also carries Index snapshots).

**Merge Host**:
The always-on Host that receives every other Host's replica and builds the Merged View (the
mini). Everything else is a spoke: it pulls, never builds.

**Edit Intent**:
A catalogue edit for a row another Host owns, sent as an `edit-intent` fleet envelope
(machine-adapter/PROTOCOL.md) instead of written locally — `ccs intent` emits, the owning
Host's `ccs apply-intents` pass applies, the next merge makes it visible. Local write verbs
refuse foreign rows and point here. Consumption is selective: each Host takes only envelopes
addressed to it (body.host), leaving the rest in the shared inbox.
_Avoid_: catalogue-edit (the issue's early name; the protocol reserved `edit-intent`), remote write.

**Cost**:
A Session's API-equivalent USD spend, summed from the exact billed `usage` fields on the
transcript's assistant lines × per-model list pricing (input/output, cache read at 0.1×,
5-minute cache writes at 1.25×, 1-hour cache writes at 2×, web searches at $10/1k).
Derived data: computed during reindex, stored in the Index (never the catalogue), and
recomputed whenever the file changes. On a subscription it is notional, not an invoice —
the metric for comparing Sessions and loops. Subagent runs are separate Index rows; the
`ls` column and `tree` Σ roll them up into their parent.
_Avoid_: price, bill, spend (when referring to the stored per-Session number).
