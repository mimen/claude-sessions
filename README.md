# ccs-go

Standalone Go port of the CCS session browser, built with Bubble Tea and
Lipgloss. The visual design is the seeded charmtone implementation in `theme/`
and the original reference shots in `shots/browser.png`, `shots/tree.png`, and
`shots/route.png`.

## Run

```bash
cd /Users/mimen/Programming/Repos/ccs-go
go run .
```

Keys in v1:

- `↑` / `↓` or `j` / `k`: move
- `g`: toggle grouped browser / causal tree
- `p`: show or hide the preview pane
- `r`: load the selected session's real resume routes
- `?`: help
- `q`: quit

Static real-data renders use the same fixed 132×40 layout as the design shots:

```bash
SHOT=browser go run .
SHOT=tree go run .
SHOT=route go run .
```

## Data source

The browser opens the existing CCS caches read-only:

- `~/.ccs/cache/index.db`: indexed transcript facts, titles, timestamps, model
  history, model costs, projects, native subagent edges, and resume IDs.
- `~/.ccs/cache/catalogue.db`: lifecycle, classification, durable identity,
  role/cluster metadata, and catalogue causal edges.
- `~/.cmuxterm/claude-hook-sessions.json` plus
  `cmux tree --all --json --id-format both`: exact live/open state and live tab
  titles, using the same surface-ID join as CCS.

This is more robust than parsing `ccs ls` or `ccs tree`: both commands are
human-formatted tables with truncation and no JSON mode, while the SQLite index
is CCS's own stable machine-readable browse cache. The Go app does **not** scan
or parse Claude JSONL transcripts and does not reimplement the CCS store. It
reproduces CCS's in-memory joins and causal cost closure from the indexed rows.
Both databases are opened with SQLite `mode=ro`; no migrations or writes run.

Path overrides for isolated runs/tests:

- `CCS_ROOT` (default `~/.ccs`)
- `CCS_INDEX_PATH`
- `CCS_CATALOGUE_PATH`
- `CCS_CONFIG_ROOT` (default `~/.ccs-config`, used only to identify loop roles)

## Wired in v1

- Real grouped sessions, preserving CCS recency and project grouping.
- CCS title precedence: live tab → custom title → role → indexed title.
- Real active/idle/completed/parked state, loop/class/role badges, age,
  dominant-model badge, cost tier, wall duration, cwd, and direct subagent count.
- Recursive self/total/provider cost rollups across both native subagent edges
  and catalogue causal edges, with cycle and duplicate-edge guards.
- Real causal tree with Claude/GPT/other rollups.
- O(viewport) list and tree rendering with cursor-centered virtualization.
- Responsive narrow-terminal rendering; the fixed two-pane split is retained at
  normal widths and the preview is suppressed when it cannot fit safely.
- Real route eligibility from the configured `[[launcher]]` fleet and the
  selected row's indexed model history, using the same glob matching and
  origin-backend default semantics as `ccs routes`. This stays in-process and
  read-only because the current CLI command opens migration-capable DB handles.
- Missing/corrupt optional catalogue or cmux data fails open to indexed sessions;
  malformed JSON cells and missing optional schema columns normalize to safe
  defaults instead of panicking.

## Deliberately stubbed

Resume and fork execution are not launched in v1. `enter`, `f`, and route-picker
activation show a clear `v1 TODO` status. Route discovery and rendering are real;
process handoff is deferred so this port does not create a second, divergent
implementation of CCS's cwd recovery, cmux focus, environment scrub, and
cross-backend resume core.

Search, transcript viewing, alternate sorts, metadata editing, refresh, and the
additional Ink TUI grouping modes are outside the requested v1 design scope.

## Verification

```bash
go test ./...
go vet ./...
go build ./...
```

Real-data proof captures are stored as:

- `shots/browser-real.png`
- `shots/tree-real.png`
- `shots/route-real.png`
