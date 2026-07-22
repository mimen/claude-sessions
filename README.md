# claude-sessions (`ccs`)

A single-machine TUI to find and resume **any** Claude Code session — regardless of which
directory it started in. Claude Code's own `--resume` picker only shows sessions for the
current directory; `ccs` shows them all, titled, searchable, and one keypress from resuming.

It's also the read-only foundation for a future session-cataloguing layer.

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

# CCS-managed launches declare their intent before a UUID is reserved:
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

`--top-level` creates a visible work body. `--child-of` creates an auxiliary session whose
cost belongs to its causal parent. A delegate call selects the seat's fixed primary route by
default; `--fallback` explicitly selects its declared backup before reservation. CCS never
automatically retries a child after launch, because the child may already have changed state;
a manual fallback invocation creates a separate auxiliary child. Auxiliary sessions are hidden in
normal list, search, and tree views; use `u` in the TUI or `--auxiliary` in CLI views to reveal
them for one invocation. Canonical delegated seats live outside Claude Code's auto-discovered
agent directories and are compiled into process-local `--agents` JSON only for the selected
delegation.

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
| `/ccs:archive` | keep the title useful, mark archived, and offer a safe tab-close link |
| `/ccs:complete` | mark the work finished while keeping the session visible in history |
| `/ccs:unarchive` | clear archive or completion flags and return to active views |
| `/ccs:title <words>` | set an explicit title verbatim and sync the cmux tab |
| `/ccs:suggest-title` | generate a title from what the session actually became |
| `/ccs:tag <entity>` | tag the session so related work is easy to find |
| `/ccs:info` | show this session's lifecycle, cost, identity, and tags |

`completed` and `archived` are different claims. Completed work stays visible in CCS
history but completed cluster members are not resumed. Archived work leaves active
browse/search views and cluster resumes. Both states are reversible; neither touches
the transcript.

## Configuration

Optional `~/.ccs/config.toml` (every key has a default):

```toml
[store]
path = "~/.claude/projects"      # where Claude Code keeps sessions

[host]
label = "<hostname>"             # tags indexed sessions with their origin host

[resume]
target = "auto"                  # auto | cmux | inline

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
