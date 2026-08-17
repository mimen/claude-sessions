# claude-sessions (`ccs`)

A single-machine Go TUI to find and resume **any** Claude Code session — regardless of which
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

For the optional live-workspace custom sidebar, see the [CCS cmux sidebar install and usage guide](integrations/cmux/README.md).
For the richer session work queue that runs in the cmux Dock, see the [productivity sidebar guide](src/sidebar/README.md) (`ccs sidebar serve`).

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
ccs finish-current complete --do     # catalogue, mark Done, enrich detached, then safely close
ccs finish-current save --do         # catalogue, save for later, enrich detached, then safely close

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
them for one invocation.

A seat IS a native Claude Code agent definition: `~/.claude/agents/<seat>.md`, frontmatter plus the
role prompt, the same file the native Agent tool auto-discovers (`--agents-root` or `CCS_AGENTS_ROOT`
override the directory). Claude Code ignores frontmatter keys it does not know, so the delegate-only
`fallback_model` / `fallback_effort` pair rides in that one file instead of a parallel registry.
`ccs delegate` reads `name`, `description`, `tools`, `model`, `effort`, and the optional
`fallback_model`, `fallback_effort`, `skills`, and `permission_mode`, ignores every other key, and
compiles them into process-local `--agents` JSON for that one delegation. A definition declares no
launcher: children are born on `claudex`. Claude models receive the client-side `[1m]` declaration;
GPT-5.6 models stay unsuffixed and use the launcher's exact 921K context environment.

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
| `/ccs:save` | save the session for later, launch detached enrichment, then safely close its workspace |
| `/ccs:complete` | mark the session Done, launch detached enrichment, then safely close its workspace |
| `/ccs:close-workspace` | close only the current session's sole-surface workspace after exact identity checks |
| `/ccs:unsave` | move a Saved session back to Active without resuming it |
| `/ccs:title <words>` | set an explicit title verbatim and sync the cmux tab |
| `/ccs:suggest-title` | generate a title from what the session actually became |
| `/ccs:tag <entity>` | tag the session so related work is easy to find |
| `/ccs:info` | show this session's lifecycle, cost, identity, and tags |

The user-facing lifecycle is Active, Parked, Saved, and Done. Parked remains active work with an
outstanding obligation. Saved leaves Active and appears in the Saved view, keeps its transcript and
context, and returns to Active after a successful explicit resume. Done is terminal until explicitly
reopened. Historical `archive` and `unarchive` CLI invocations remain compatibility aliases for Done
and reopen; they never create Saved sessions.

`ccs finish-current <complete|save>` is a close preflight only: it performs no catalogue,
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

### Launchers

A **launcher** is one Claude Code executable. `[[launcher]]` entries declare which exist on this
host and the model-id globs each backend can replay; `ccs routes`, `ccs resume --via`,
`ccs swap-harness` and `ccs restart` all read this fleet. With no `[[launcher]]` entries the tool
runs on a single hardcoded `claude` and the feature is invisible — the fleet is deliberately
**config, not code**, because launcher names are per-host facts (a binary that is not installed
must not be offered as a route).

The reference fleet separates process-wide context envelopes while keeping Claude and GPT-5.6 on
the daily mixed-vendor launcher:

```toml
[[launcher]]
name = "claudex"
binary = "claudex"
serves = ["claude-*", "gpt-5.6-*"]

[[launcher]]
name = "claude-native"
binary = "claude-native"
serves = ["claude-*", "anthropic.*"]

[[launcher]]
name = "claude-gpt"
binary = "claude-gpt"
serves = ["gpt-5.6-*"]

[[launcher]]
name = "claude-gpt55"
binary = "claude-gpt55"
serves = ["gpt-5.5"]

[[launcher]]
name = "local-mlx"
binary = "local-mlx"
serves = ["qwen3.8-local"]
```

`serves` decides eligibility and preselection. Routing keys on a session's last model, and the most
specific matching glob wins. The model-specific patterns are also a safety boundary: a 272K GPT-5.5
session must not restart inside GPT-5.6's 921K process envelope, and Qwen's 262,144-token process must
not inherit either GPT limit.

**Which launcher a new session is born on** is answered by the location registry's
`default_harness` / `default_model` pair (`[routing].registry`), not by fleet order. The pair is
validated against the exact context-safe model patterns above.

#### Launcher environment

`env` is the **single source** of a launcher's environment, and `clears` is the list of inherited
variables unset before it applies. A `@file:<path>` value names a file whose first line IS the
value, so a secret is referenced from config instead of copied into it — rotating the credential
is a write to that one file, and config.toml never holds it:

```toml
[[launcher]]
name = "claudex"
binary = "claudex"
serves = ["claude-*", "gpt-5.6-*"]
[launcher.env]
ANTHROPIC_BASE_URL = "http://127.0.0.1:8317"
ANTHROPIC_AUTH_TOKEN = "@file:~/.cli-proxy-api-key"
ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-5[1m]"
CLAUDE_CODE_MAX_CONTEXT_TOKENS = "921000"
CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1000000"

[[launcher]]
name = "claude-gpt55"
binary = "claude-gpt55"
serves = ["gpt-5.5"]
[launcher.env]
ANTHROPIC_BASE_URL = "http://127.0.0.1:8317"
ANTHROPIC_AUTH_TOKEN = "@file:~/.cli-proxy-api-key"
CLAUDE_CODE_MAX_CONTEXT_TOKENS = "272000"
CLAUDE_CODE_AUTO_COMPACT_WINDOW = "272000"

# The gateway escape hatch strips inherited route and context variables before reaching Anthropic.
[[launcher]]
name = "claude-native"
binary = "claude-native"
serves = ["claude-*", "anthropic.*"]
clears = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
]
```

`ccs launcher install` materializes each launcher's `env`/`clears` into `~/.ccs/launcher-env/`
and installs the configured bundled wrappers beside the PATH-precedent `~/.ccs/bin/claude` shim.
Each named wrapper forces its own launcher environment before the shim execs the raw binary, while
plain **`claude` remains an indirection**: which launcher it resolves to is the location
registry's `default_harness`, the same value that decides where a managed birth lands, so the
fleet moves — or falls back to `claude-native` — in one edit. A wrapper names itself by exporting
`CCS_FORCE_HARNESS=<name>` and executes the sibling `~/.ccs/bin/claude` shim by absolute path. That
bounce through the shim registers the session birth without depending on PATH or shell startup.

Re-run `ccs launcher install` after editing a launcher's name, binary, `env`, `clears`, or `default_harness`.

`clears` is applied by EVERY path that starts a process on an explicitly chosen launcher — the
shim, `ccs resume --via`, a managed birth, `ccs swap-harness`, `ccs restart` — all from one
compiled directive list. That matters because `claude-native` is only a real escape hatch if the
gateway variables are actually stripped: a `--via claude-native` child of a gateway session would
otherwise inherit `ANTHROPIC_BASE_URL` and quietly stay on the gateway.

#### The shared launcher registry (versioned)

`~/.ccs/config.toml` is machine-local runtime state — not a git repo, backed up nowhere. Since
`[[launcher]].env` is the single source of the harness environment, keeping the fleet only there
means one lost file loses the gateway URL, the token reference, and every model slot with no
record. So the fleet also has a **shared registry**: a curated TOML file in a git-backed location,
reached through `[routing].launchers` and defaulting to `~/.ccs/launchers.toml` — normally a
symlink into the vault, exactly like `locations.toml` and `hosts.toml` already are.

```toml
# ~/Documents/milad-vault/ClaudeConfig/session-routing/launchers.toml
version = 1

[[launcher]]
name = "claudex"
binary = "claudex"
serves = ["claude-*", "gpt-5.6-*"]
[launcher.env]
ANTHROPIC_BASE_URL = "http://127.0.0.1:8317"
ANTHROPIC_AUTH_TOKEN = "@file:~/.cli-proxy-api-key"
CLAUDE_CODE_MAX_CONTEXT_TOKENS = "921000"
CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1000000"

[[launcher]]
name = "claude-native"
binary = "claude-native"
serves = ["claude-*", "anthropic.*"]
clears = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
]
```

Link it into place with `ln -s <vault>/ClaudeConfig/session-routing/launchers.toml
~/.ccs/launchers.toml`, then `ccs launcher install`.

The **secret is still never committed**: values keep the `@file:<path>` shape, so what git holds is
the NAME of the file containing the token, never the token. **Per-machine differences remain
possible**: a `[[launcher]]` entry in `config.toml` overrides the shared entry of the same name
(keeping its registry position, since order is the no-history tie-break) and a name that appears
only in `config.toml` is appended. That is what lets one host declare a binary the others don't
have. A host with no registry file behaves exactly as before — `config.toml` is the whole fleet.

#### Drift

```
ccs doctor launcher [--json]
```

Reports, and never repairs: the deployed checkout's revision against its **origin default branch**
(the stale-deploy case that hid behind a local branch 75 commits behind origin), each installed
wrapper/env-spec against what the current config would generate, and any declared launcher whose
env spec is missing or unreadable. A launcher with no spec is called out specifically, because the
shim launches an unknown launcher with the *inherited* environment. Every finding names the command
that fixes it; exit code is 1 when there is drift, 0 for warnings alone.

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
