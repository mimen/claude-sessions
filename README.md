# ccs-go

A standalone Go + Bubble Tea session manager for CCS. It is navigate-led: launch answers “what needs me,” resume and organization are one key away, and cost remains visible without becoming the primary axis.

The UI reads the real CCS stores directly in SQLite read-only mode. Every metadata mutation is delegated to the installed `ccs` CLI so the TypeScript implementation remains the owner of migrations and invariants.

## Run

```bash
cd /Users/mimen/Programming/Repos/ccs-go
go run .
```

The default launch reads the real store under `~/.ccs/cache/`. Static renders use the same real data:

```bash
SHOT=browser go run .
SHOT=transcript go run .
SHOT=route go run .
SHOT=organize go run .
SHOT=ai go run .
SHOT=skills go run .
SHOT=skill-reader go run .
```

## Session keys

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move the selected session |
| `enter` | Focus an already-live cmux session, otherwise exit the TUI and resume inline on its origin backend |
| `r` | Pick an eligible launcher or a focused cmux workspace (`claude`, `claude-gpt`, configured launchers, `cmux`) |
| `g` | Cycle `default` → `tree` → `flat` |
| `/` | Fuzzy filter title, project, and Claude task subjects |
| `p` | Show or hide the dossier |
| `J` / `K` | Scroll the selected session’s normalized transcript peek |
| `v` | Open the full transcript pager |
| `t` | Retitle through `ccs session title` |
| `C` | Confirm and mark done through `ccs mark --completed` |
| `X` | Confirm and archive through `ccs mark --archived` |
| `e` | Describe a single-session metadata edit in natural language; review validated mutations before applying them through `ccs` |
| `S` | Generate a 2–3 line transcript summary in the dossier |
| `A` | Ask the fleet a semantic question across bounded transcript excerpts; `enter` jumps to a result |
| `D` | Generate a conservative cleanup proposal; `space` toggles entries and `y` archives the approved set through `ccs` |
| `Tab` | Toggle Skills mode |
| `?` | Help |
| `q` | Quit |

Transcript pager keys: `j` / `k`, `PgUp` / `PgDn`, `g` / `G`, and `v` / `esc` to close.

## Landing views

### Default: cluster + lifecycle

Named systems lead the page. Each cluster is split by role (coordinator/control, scout/support, workers, and any other configured roles). The large `(no-system)` remainder is split into fixed navigation queues:

1. `active`
2. `idle`
3. `parked`
4. `done`

Archived, auxiliary, and native subagent runs are hidden. There is deliberately no visibility-toggle mode in v1.

### Tree

The causal parent→child tree retains recursive self/total cost and Claude/GPT/other provider rollups. Rendering is cursor-centered and viewport-bounded.

### Flat

A pure recency list with no grouping. Fuzzy filtering works in default and flat views.

## Dossier and transcripts

The right-hand dossier includes:

- lifecycle, class, role, cluster, cwd, duration, age, and subagent count;
- self/recursive total cost and provider split;
- dominant model;
- Claude task subjects and completion count;
- on-demand AI summary;
- lazily loaded recent transcript peek.

The shared `transcript/` reader streams or tail-reads JSONL, skips corrupt records, strips terminal controls, omits hidden reasoning, summarizes tool calls/results, and applies bounded-memory retention. It normalizes:

- native Claude Code `user` / `assistant` records with string or Anthropic content blocks;
- `claude-gpt` gateway transcripts, including split assistant/tool records in the Anthropic-compatible envelope;
- direct gateway `role` / `content` records;
- OpenAI Responses-style `response.output_text` and output-item records.

The full pager retains the most recent 2,000 rendered turns and labels a truncated document as a recent tail. Fleet-wide AI calls use byte-bounded transcript tails plus CCS’s indexed opening/closing skeleton, avoiding full rescans of hundreds of large files.

## Resume contract

Closed sessions resume with:

```text
<launcher binary> --resume <indexed resume_id>
```

The recorded cwd is preferred, then the project root, then the home directory. Inline resume is stored in the final Bubble Tea model, the alternate screen exits, and only then does the launcher inherit stdin/stdout/stderr. This prevents the TUI and interactive Claude process from owning the terminal simultaneously.

Launcher eligibility and origin-backend selection mirror CCS model-glob semantics. A pure GPT history selects the most specific eligible `gpt-*` launcher; mixed/unknown histories fall back to an eligible catch-all. If `claude-gpt` is installed and no launcher config exists, it is exposed automatically alongside `claude`. `cmux` creates a new focused workspace with safe shell quoting and launcher environment variables. A session already live in cmux is focused by its exact surface-derived workspace/window refs instead of duplicated.

## Write ownership

SQLite is never opened for writing by this program. There is no Go mutation schema or migration path.

| UI operation | Existing owner command |
| --- | --- |
| Retitle | `ccs session title <id> <title>` |
| Done / undoable AI lifecycle change | `ccs mark <id> --completed [--off]` |
| Archive / cleanup | `ccs mark <id> --archived [--off]` |
| Parent, parked task, identity attachment | `ccs session set` / `ccs session unset` |
| Durable identity field | `ccs identity set <key> --field=value` or `--unset=field` |

The AI editor returns schema-forced mutations against a numbered session list. Go validates the focus session, operation, parent references, identity keys, booleans, title bounds, and identity-field allowlist. Each approved mutation is then executed as a separate `ccs` subprocess. Cleanup similarly applies one `ccs mark --archived` call per approved session.

## Inference seam

`inference/engine.go` mirrors `claude-sessions/src/inference/engine.ts`:

1. `CCS_INFERENCE_ENGINE` / CCS config preference, otherwise Codex first and Claude fallback.
2. Codex: `codex exec --ephemeral --sandbox read-only --ignore-rules --ignore-user-config`, JSON Schema file, and `--output-last-message`.
3. Claude: `claude -p --no-session-persistence --strict-mcp-config --output-format json --json-schema ...`.
4. Bounded stdin payload, timeout, schema-forced result, and no agentic tool access.

The same seam powers `e`, `S`, ask-the-fleet, and cleanup. There are no background model calls.

## Skills mode

`Tab` opens a separate machine-wide Skills registry. It reads `~/.ccs/cache/skills.db` in SQLite `mode=ro` when populated. If the rebuildable cache is empty or on an older schema, it scans installed/global skills, plugin cache, the canonical vault registry, vault workspaces, and programming repositories without writing a cache.

Skills keys:

| Key | Action |
| --- | --- |
| `Tab` | Return to sessions |
| `↑` / `↓`, `j` / `k` | Move |
| `g` | Cycle category → home → flat |
| `/` | Fuzzy filter name, description, path, category, and tags |
| `p` | Toggle metadata/file preview |
| `v` / `enter` | Open the selected skill’s file reader |
| `R` | Rescan the read-only registry |
| `q` | Quit |

The skill reader opens `SKILL.md` first, lists bounded text/Markdown/JSON/TOML/YAML files, uses `Tab` / arrows to cycle files, and supports the same pager keys as transcripts.

## Read-only data sources

- `~/.ccs/cache/index.db`: paths, cwd/project, titles, timestamps, models, costs, transcript skeleton, subagent edges, and resume IDs.
- `~/.ccs/cache/catalogue.db`: session lifecycle/classification/parentage plus identity cluster/role joins.
- `~/.cmuxterm/claude-hook-sessions.json` and `cmux tree --all --json --id-format both`: exact live state and workspace/window location.
- `~/.claude/tasks/<session-id>/*.json`: task subjects and completion counts.
- Session JSONL paths indexed in `index.db`: dossier peek, pager, summaries, fleet search, and cleanup evidence.
- `~/.ccs/cache/skills.db` and installed/project skill directories: Skills mode.

Path overrides for isolated runs/tests:

- `CCS_ROOT`
- `CCS_INDEX_PATH`
- `CCS_CATALOGUE_PATH`
- `CCS_CONFIG_ROOT`
- `CCS_TASKS_PATH`
- `CCS_SKILLS_DB_PATH`
- `CCS_BINARY`
- `CMUX_BIN`
- `CCS_INFERENCE_ENGINE`

## Deliberately deferred or cut

The locked v1 excludes:

- fork resume and inline↔cmux swap;
- task/auxiliary/archive visibility toggles;
- literal full-text grep;
- background needs-input triage or push notifications;
- auto-title/classify;
- bulk natural-language reorganization;
- inference-engine switching inside the TUI;
- epic view.

Skills organization writes (tags, categories, archive/move, opening an editor) are not ported; Skills mode is read-only in this Go v1. Alternate session sorts are also omitted: default and flat are recency-led, while tree uses causal cost ordering.

## Verification

```bash
go test ./...
go vet ./...
go build ./...
go run .
```

Real-data proof captures:

- `shots/default-real.png`
- `shots/transcript-peek-real.png`
- `shots/transcript-reader-real.png`
- `shots/resume-picker-real.png`
- `shots/organize-real.png`
- `shots/ai-summary-real.png`
- `shots/skills-real.png`
- `shots/skill-reader-real.png`
