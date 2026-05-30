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

- **claude** (required) — resume runs `claude --resume`.
- **codex** (optional) — fills in titles for sessions Claude Code didn't title. Uses your
  existing Codex auth; no model is hard-coded (inherits your Codex default). Codex is used
  here (rather than `claude -p`) deliberately: title generation is a non-interactive,
  high-volume background job, and running Claude commands non-interactively is expected to
  start incurring API charges — so titling rides your existing Codex/ChatGPT auth instead to
  avoid that cost. The titler sits behind one interface, so swapping back to `claude -p` is a
  one-file change if that calculus ever flips.
- **cmux** (optional) — when reachable, resume opens a named cmux workspace.

## Usage

```sh
ccs                    # launch the browser
ccs reindex            # refresh the index from the store (incremental)
ccs reindex --titles   # also generate missing titles (cron/launchd-friendly)
ccs ls                 # debug: print the indexed sessions
```

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
| `a` | show / hide subagent runs |
| `t` | re-title the selected session |
| `q` / `esc` | quit |

## Configuration

Optional `~/.claude-sessions/config.toml` (every key has a default):

```toml
[store]
path = "~/.claude/projects"      # where Claude Code keeps sessions

[host]
label = "<hostname>"             # tags indexed sessions with their origin host

[resume]
target = "auto"                  # auto | cmux | inline

[titler]
binary = "codex"
model = ""                       # "" = inherit your Codex default (account-safe)
reasoningEffort = "low"
concurrency = 3
maxAttempts = 3
```

## How it works

- The **store** (`~/.claude/projects/`) is the single source of truth; `ccs` never writes to
  it. Sessions are `<uuid>.jsonl`; the working directory is encoded in the folder name.
- The **index** (`~/.claude-sessions/index.db`, SQLite) is a pure, rebuildable cache —
  delete it any time and `ccs reindex` reconstructs it. Reindex is incremental (only changed
  files are re-parsed). Big transcripts are streamed, never fully loaded.

> **Retention:** Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30).
> Set it higher in `~/.claude/settings.json` to keep history; already-pruned sessions are
> unrecoverable. A future `ccs` archive mode will copy transcripts out before they're pruned.

See `CONTEXT.md` for the glossary and `docs/adr/` for architecture decisions.
