# claude-sessions (`ccs`)

A single-machine TUI to find and resume **any** Claude Code session — regardless of which
directory it started in. Claude Code's own `--resume` picker only shows sessions for the
current directory; `ccs` shows them all, titled, searchable, and one keypress from resuming.

It's also the read-only foundation for a future session-cataloguing layer.

## Two interfaces (the Ink TUI is deprecated)

`ccs` now launches the **Go TUI** in [`tui-go/`](tui-go/) — the default and the one that gets new
work. It is built on demand (a rebuild happens only when a Go source file changed) and reads the
CCS store read-only, routing every mutation back through the `ccs` CLI.

The original Ink/React TUI is still reachable as **`ccs classic`**, prints a deprecation notice,
and **will be removed** once the Go TUI closes its remaining parity gaps — fork-resume, full-text
search, and narrow-terminal layout. A verified feature-by-feature comparison of the two lives in
[`docs/ccs-vs-ccs-go.md`](docs/ccs-vs-ccs-go.md).

## What it does

- **Browse** every session on this machine, newest-activity first, across all directories.
- **Titles** for each session: Claude Code's native `ai-title` when present, otherwise one
  generated with Codex, otherwise a cleaned first message.
- **Search** (`/`) — fuzzy over title/project, full-text over a content skeleton.
- **Group** (`g`) by project (git-repo root; a repo's root and subdirs collapse together).
- **Preview** (`p`) — full metadata + a content peek, including subagent relationships.
- **Resume** (`↵`) in the session's original directory — into a named **cmux** workspace when
  cmux is running, otherwise an inline terminal hand-off. Fork with `f`.
- **Subagent runs are hidden by default** (they're not interactive sessions you can resume);
  toggle with `a`. Each shows the parent session that spawned it.

## Install

Requires [Bun](https://bun.sh). On each machine:

```sh
git clone <repo> ~/Programming/Repos/claude-sessions
cd ~/Programming/Repos/claude-sessions
bun install
bun run setup     # bun link → `ccs` on your PATH; checks optional deps
```

Update later with `git pull`.

### Dependencies

- **claude** (required) — resume runs `claude --resume`. Also works as an **inference engine**
  (see below) for titling and the plain-English catalogue editor, via `claude -p`.
- **codex** (optional) — the other inference engine. Rides your existing Codex/ChatGPT auth
  (no marginal cost), which is why it's preferred for the high-volume background titling job.
- **inference engine selection** — `ccs` needs one of `codex` or `claude` on your PATH to
  generate titles and run the plain-English editor. By default it auto-detects: it uses
  whichever is installed, preferring `codex` (free auth) when both are. Force a choice with
  `inference.engine` in the config, the `CCS_INFERENCE_ENGINE` env var (`codex` | `claude` |
  `auto`), or — when both are installed — the in-TUI `i` toggle (persisted across runs).
- **cmux** (optional) — when reachable, resume opens a named cmux workspace.

## Usage

```sh
ccs                    # launch the browser
ccs reindex            # refresh the index from the store (incremental)
ccs reindex --titles   # also generate missing titles (cron/launchd-friendly)
ccs ls                 # debug: print the indexed sessions
ccs start              # fresh managed launcher; prefill /ccs:new without submitting
ccs start "fix checkout routing"  # append initial text, still leave it unsubmitted
ccs start -- --leading-dash-text   # preserve dash-leading initial text safely
ccs location list      # list curated session starting locations
ccs location match "work on the session catalogue" --json
ccs location show ccs
ccs finish-current complete          # dry-run the exact current workspace close only
ccs finish-current complete --do     # catalogue, complete, enrich detached, then safely close
ccs finish-current archive --do      # catalogue, archive, enrich detached, then safely close

# CCS-managed launches declare their intent before a UUID is reserved:
ccs session new --top-level --location ccs --model gpt-5.6-sol --json --prompt "Implement the router"
ccs session new --top-level --host Milads-Mac-mini --location ccs \
  --require-capability always-on --require-capability shared-vault --prompt "Implement remotely"
ccs session new --top-level --cwd /path/to/repo
ccs session new --child-of . --cwd /path/to/repo

# Run one canonical seat as a synchronous, causally parented helper:
ccs delegate primary-review --child-of . --cwd /path/to/repo --prompt "Review the diff."

# Explicitly select the seat's declared fallback before launch:
ccs delegate primary-review --fallback --child-of . --cwd /path/to/repo --prompt "Review the diff."

# Reserve a transcript-free automation anchor, then run synchronous attributed children:
ANCHOR_ID="$(CCS_CREATOR_KIND=automation CCS_CREATOR_REF=imsg-server ccs session new \
  --top-level --cwd /path/to/repo --title 'iMessage server' --print-id)"
CCS_CREATOR_KIND=automation CCS_CREATOR_REF=imsg-server ccs delegate utility \
  --child-of "$ANCHOR_ID" --cwd /path/to/repo --prompt "Classify this request."
```

`/ccs:new <initial prompt>` is the only conversational router. `ccs start` is a deterministic
interactive shortcut: it creates one fresh CCS-managed top-level launcher in the current directory,
focuses the new cmux workspace, waits for Claude's empty composer, and types `/ccs:new ` plus any
trailing argv text. It never presses Enter, reuses an idle session, runs inference, routes the task,
or executes the prompt. `--dry-run` and `--explain` are obsolete and rejected; use `--` before text
that must literally begin with one of those tokens. Input that cmux would reinterpret as Enter or Tab
is rejected before birth rather than partially submitted.

`--top-level` creates a visible work body. `--child-of` creates an auxiliary session whose
cost belongs to its causal parent. A delegate call selects the seat's fixed primary route by
default; `--fallback` explicitly selects its declared backup before reservation. CCS never
automatically retries a child after launch, because the child may already have changed state;
a manual fallback invocation creates a separate auxiliary child. Auxiliary sessions are hidden in
normal list, search, and tree views; use `u` in the TUI or `--auxiliary` in CLI views to reveal
them for one invocation. Canonical delegated seats live outside Claude Code's auto-discovered
agent directories and are compiled into process-local `--agents` JSON only for the selected
delegation.

`--model` accepts a canonical birth-model ID and derives the matching launcher; it cannot be combined
with legacy `--via`. Registered location overrides inherit the registry-wide exact route when omitted.
`--require-capability` is repeatable and rejects a host before reservation or workspace creation when
its authored capability list does not satisfy the request. `--json` returns the detached local birth's
full session ID, canonical route, and workspace reference, retaining the recoverable ID on failure.

`--host` accepts a canonical name from `hosts.toml`. The current host keeps the established local
launch path. A remote top-level location birth first checks the registered SSH alias, remote login-shell
`ccs`, readable remote location registry, and location eligibility, then creates exactly one local
`cmux ssh` workspace whose initial command is remote `ccs session new --top-level --inline`. It never
launches a raw Claude process or retries automatically. The first transport release returns the cmux
workspace reference with `session_id: pending`; remote reservation and prompt delivery remain explicitly
uncertain until the stronger session-ID receipt seam lands.

### Keys

| key | action |
|-----|--------|
| `↑↓` / `j` `k` | move |
| `↵` | resume (or expand a project group) |
| `f` | fork-resume (`--fork-session`) |
| `o` | resume via the other target (inline ↔ cmux) |
| `/` | search |
| `g` | toggle group-by-project |
| `p` | toggle preview pane |
| `a` | show / hide native subagent runs |
| `u` | show / hide auxiliary delegated sessions (resets hidden each launch) |
| `t` | re-title the selected session |
| `i` | swap inference engine (codex ⇄ claude; shown only when both are installed) |
| `q` / `esc` | quit |

## Slash commands (the `ccs` plugin)

The TUI catalogues sessions from the outside. The plugin does it from inside the
conversation, where filing the work is one command away.

```sh
/plugin marketplace add mimen/claude-sessions
/plugin install ccs@claude-sessions
/reload-plugins        # only needed in an already-running session
```

| command | what it does |
|---------|--------------|
| `/ccs:new <initial prompt>` | choose a registered launch location conversationally and create one fresh CCS-managed session |
| `/ccs:archive` | synchronously archive, launch detached enrichment, then safely close its workspace |
| `/ccs:complete` | synchronously complete, launch detached enrichment, then safely close its workspace |
| `/ccs:close-workspace` | close only the current session's sole-surface workspace after exact identity checks |
| `/ccs:unarchive` | clear archive or completion flags and return to active views |
| `/ccs:title <words>` | set an explicit title verbatim and sync the cmux tab |
| `/ccs:suggest-title` | generate a title from what the session actually became |
| `/ccs:tag <entity>` | tag the session so related work is easy to find |
| `/ccs:info` | show this session's lifecycle, cost, identity, and tags |

`completed` and `archived` are different claims. Completed work stays visible in CCS
history but completed cluster members are not resumed. Archived work leaves active
browse/search views and cluster resumes. Both states are reversible; neither touches
the transcript.

`ccs finish-current <complete|archive>` is a close preflight only: it performs no catalogue,
lifecycle, or enrichment mutation. With `--do`, it validates the explicit current session UUID,
ensures the catalogue row, records the per-session lifecycle, launches `ccs enrich <uuid>` through
`/usr/bin/nohup` with per-session runtime logging, then hands closure to the existing two-snapshot
stable-UUID guard. A lifecycle failure stops before enrichment or close; an enrichment launch
failure warns and still closes because the stale row remains eligible for `ccs enrich --sweep`.

## Configuration

Optional `~/.ccs/config.toml` (every key has a default):

```toml
[store]
path = "~/.claude/projects"      # where Claude Code keeps sessions

[host]
label = "<hostname>"             # tags indexed sessions with their origin host

[resume]
target = "auto"                  # auto | cmux | inline

[routing]
registry = "~/Documents/milad-vault/ClaudeConfig/session-routing/locations.toml"
hosts = "~/Documents/milad-vault/ClaudeConfig/session-routing/hosts.toml"

[inference]
engine = "auto"                  # auto | codex | claude (env CCS_INFERENCE_ENGINE overrides)

[inference.codex]
binary = "codex"
model = ""                       # "" = inherit your Codex default (account-safe)
reasoningEffort = "low"

[inference.claude]
binary = "claude"
model = "haiku"                  # cheap model for background titling; "" = CLI default

[titler]
concurrency = 3
maxAttempts = 3
```

The shared host registry defaults to `~/.ccs/hosts.toml`:

```toml
version = 1

[[host]]
name = "Milads-Mac-mini"       # canonical host identity from [host].label / LocalHostName
ssh_alias = "macmini"          # one SSH config destination, never command-line options
status = "active"              # active | retired
```

Canonical names and SSH aliases are unique after trimming and case normalization. Retired hosts cannot receive new placements.

## How it works

- The **store** (`~/.claude/projects/`) is the single source of truth; `ccs` never writes to
  it. Sessions are `<uuid>.jsonl`; the working directory is encoded in the folder name.
- The **index** (`~/.ccs/cache/index.db`, SQLite) is a pure, rebuildable cache —
  delete it any time and `ccs reindex` reconstructs it. Reindex is incremental (only changed
  files are re-parsed). Big transcripts are streamed, never fully loaded.

> **Retention:** Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30).
> Set it higher in `~/.claude/settings.json` to keep history; already-pruned sessions are
> unrecoverable. A future `ccs` archive mode will copy transcripts out before they're pruned.

See [`docs/managed-session-launches.md`](docs/managed-session-launches.md) for the agent and automation launch contract, `CONTEXT.md` for the glossary, and `docs/adr/` for architecture decisions.
