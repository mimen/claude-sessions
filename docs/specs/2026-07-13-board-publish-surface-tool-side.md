# Board publish surface — ccs tool-side spec (ready-to-implement)

Companion to ADR-0077. Turns the ADR into the concrete ccs work: types, CLI, render/paint switches, indexer. Cluster-side engine spec is in the pr-watch repo (2026-07-13-phase-first-board-engine.md); this spec is everything ccs itself must ship.

Design invariants (from ADR-0077):
- Board rows key on **identity** (`cluster:role:work-unit`), never sessionId.
- Every op has a single-row variant.
- Tool defines the schema + render primitives; clusters own alerts + phase vocabulary + `data`.
- Cmux paint + TUI read board.json, not `catalogue.stage`.
- After state-changing writes, callers trigger a synchronous single-row recompose before returning.

---

## 1. Types (`src/board/types.ts`, new)

The tool's canonical row shape. Every field except `data` is what ccs KNOWS HOW TO RENDER; `data` is opaque.

```ts
/** A cmux sidebar pill the tool paints as-is. Vocabulary is cluster-defined. */
export interface Pill {
  key: string;              // stable key; existing STAGE_PILL uses "ccs_lifecycle"
  label: string;            // display text (e.g. "in review", "ci-red")
  icon?: string;            // cmux icon name; if absent, no icon
  color?: string;           // hex color; if absent, cmux default
  priority?: number;        // sort within the pill row; higher = shown first
}

/** A named sensor-backed alert. Tool renders (as a badge, pill, or list); doesn't interpret. */
export interface Alert {
  name: string;             // stable slug (e.g. "ci-red", "changes-requested")
  severity: "hard" | "soft";
  reason: string;           // human-readable one-liner
  owner: string;            // cluster-defined vocabulary ("control", "concierge", …)
  sinceTick?: number;       // ticks since first fired (composer-tracked, optional)
}

/** A session's presence on this identity (for the composed row's session list). */
export interface RowSession {
  sessionId: string;
  isPrimary: boolean;       // true for exactly one session per identity (freshest MRU)
  lastActivity: string;     // ISO timestamp of the last SessionStart/Stop for this session
}

/** The composed row for one identity. Written by the cluster's composer, read by ccs consumers. */
export interface BoardRow {
  identity: string;                                 // "<cluster>:<role>:<work-unit>"
  workUnit: { kind: string; [k: string]: unknown }; // cluster-shaped; tool doesn't parse beyond `kind`
  sessions: RowSession[];                           // 0+; empty = ticketed-no-session
  pills: Pill[];                                    // rendered in order of priority desc
  description: string | null;                       // freeform freshest signal (overlays statusLine)
  alerts: Alert[];                                  // 0+; rendered per cluster rules
  awaitingFrom: string[];                           // cluster vocabulary; tool renders as text
  lastComposed: string;                             // ISO; composer sets on every write
  data?: Record<string, unknown>;                   // opaque cluster-private stash
}

/** The whole board.json file. */
export interface Board {
  status: "OK" | "DEGRADED" | "FAILED";
  provenance: { source: string; command?: string; at: string };
  rows: BoardRow[];
  senses?: Record<string, { status: string; lastRun?: string }>; // cluster-shaped sensor healths
  counts?: Record<string, number>;
  clusterData?: Record<string, unknown>;            // cluster-arbitrary top-level extras (e.g. sprints)
}
```

**No cluster vocabulary in these types.** No `"building"` / `"in-review"` string literals; no `"ci-red"` alert names; no `"reviewers"` in `awaitingFrom`. Every value is a cluster string the tool renders opaquely.

---

## 2. `src/board/paths.ts` (new)

Canonical paths + atomic write helpers.

```ts
/** ~/.ccs/clusters/<cluster>/cluster/board.json */
export function boardPath(cluster: string): string;

/** Atomically write board.json (temp + rename). */
export function writeBoard(cluster: string, board: Board): void;

/** Read board.json; returns null if missing. Throws on parse errors (loud). */
export function readBoard(cluster: string): Board | null;
```

Atomicity via `writeFileSync(temp)` + `renameSync(temp, target)` — POSIX guarantees on the same filesystem.

---

## 3. `src/board/indexer.ts` (new — the light indexer)

The indexer is an in-memory cache mapping `identity` → row and `sessionId` → identity. Invalidated by any composer write (detected via `fs.statSync(boardPath).mtimeMs`). Lookups are O(1); the whole file is parsed only when mtime changes.

```ts
export interface BoardIndex {
  /** Look up a row by identity key. */
  byIdentity(identity: string): BoardRow | null;

  /** Resolve a session id to its identity + row. Uses catalogue.identityKeyOf for the session→identity
   *  hop, then the identity→row cache. Returns null if the session has no identity or the identity
   *  has no row. */
  bySession(sessionId: string): { identity: string; row: BoardRow } | null;

  /** All rows. Consumers should prefer byIdentity/bySession where possible. */
  rows(): BoardRow[];

  /** Force a re-read (bypasses mtime check). Useful right after a --recompose call. */
  refresh(): void;
}

/** Build (or reuse) the indexer for a cluster. Cheap to call repeatedly. */
export function boardIndex(cluster: string): BoardIndex;
```

Implementation notes:
- Cache the parsed `Board` + `Map<identity, BoardRow>` + `Map<sessionId, identity>` at module scope, keyed by cluster.
- On every call, `statSync(boardPath).mtimeMs` — if unchanged, return cached; otherwise reparse.
- `bySession` uses `catalogue.identityKeyOf(row)` under the hood. If the catalogue row is missing (unindexed session), returns null.
- Missing `board.json` → `byIdentity`/`bySession` return null. Callers apply their own fallback (see §5, §6).

---

## 4. `src/cli.ts` — the `ccs board` op family

Extend the existing `case "board":` dispatch. Current form is `ccs board <cluster> [--json | --text]`. Adds:

```
ccs board <cluster>                              # human table (unchanged)
ccs board <cluster> --json                       # full board (unchanged, but new schema)
ccs board <cluster> --identity <key>             # single-row read, JSON
ccs board <cluster> --identity <key> --text      # single-row human render
ccs board <cluster> --recompose <key>            # invoke cluster composer for one identity, wait for it
ccs board <cluster> --recompose-all              # full recompose, wait for it (blocks; useful post-migration)
ccs board <cluster> --session <sid>              # convenience: session→identity, then --identity
```

Behavior:

- `--identity <key>` — read board.json, look up row, print. Exit 1 if not found.
- `--recompose <key>` — invoke the cluster's composer (from `cluster.toml`'s `board` entry) with argv `<composer> --identity <key> --write`. Block until it exits. If the cluster has no composer, fall through to the default composer (§7). Print the recomposed row.
- `--recompose-all` — invoke composer with `--write` (whole-board mode). Blocks. For migration and debugging; not for hot paths.
- `--session <sid>` — resolve session→identity via `catalogue.identityKeyOf`; error if no identity; then delegate to `--identity`.

Errors:
- Missing composer entry in cluster.toml: log a `default composer` warning, still proceed with the default.
- Composer nonzero exit: bubble the exit code, log stderr.
- board.json missing after a `--recompose-all`: hard error (composer broken).

---

## 5. `src/catalogue/render-tab.ts` — switch to reading board.json

Currently `computePhasePill(row: CatalogueRow)` reads `row.stage`. Switch to: **look up the composed row by session id via the indexer; render whatever pills the composer emitted**. Falls back to reading `row.stage` when the board is unavailable.

Change surface:

```ts
// current
function computePhasePill(row: CatalogueRow): StatusPill | null {
  const stageKey = row.stage?.trim().toLowerCase();
  if (!stageKey || !STAGE_PILL[stageKey]) return null;
  const stage = STAGE_PILL[stageKey];
  return { key: "ccs_lifecycle", label: stage.label, icon: stage.icon, color: stage.color, priority: 50 };
}

// new
function computePillsFromBoard(row: CatalogueRow): StatusPill[] {
  if (!row.cluster) return [];
  const idx = boardIndex(row.cluster);
  const hit = idx.bySession(row.sessionId);
  if (!hit) return [];  // caller applies legacy fallback
  return hit.row.pills.map(pill => ({ key: pill.key, label: pill.label, icon: pill.icon ?? "", color: pill.color ?? "", priority: pill.priority ?? 50 }));
}
```

Fallback chain in the caller (`renderTab`):
1. Try `computePillsFromBoard(row)`. If non-empty, use those pills.
2. Else try `computePhasePill(row)` (legacy path — reads `row.stage`). If non-null, wrap in `[pill]`.
3. Else `computeLifecyclePill(row)` (existing lifecycle fallback).

Description overlay stays as-is BUT also consults the board row: if the board row has `description`, prefer it over `row.statusLine` (composed truth wins over stale in-flight status). If board is missing, statusLine wins as today.

Alerts rendering (NEW): for each hard alert on the row, emit an additional pill:

```ts
function alertPills(row: BoardRow): StatusPill[] {
  return row.alerts
    .filter(a => a.severity === "hard")
    .map(a => ({ key: `ccs_alert_${a.name}`, label: a.name, icon: "exclamationmark.triangle", color: "#ff453a", priority: 40 }));
}
```

Priority 40 is below the state pill (50) and epic pill (60) — the state pill leads. Soft alerts are not rendered as pills; they show up in the description or hover tooltip only (out of scope for this spec).

Cmux collapses past ~3 pills. Budget: `epic (60) → state (50) → hardest-alert (40)`. If more than one hard alert fires, we emit the highest-severity+earliest-fired one only; the rest are visible in the TUI/board.

---

## 6. `src/tui/columns.ts` + `SessionList.tsx` — TUI stage column reads board

Current: `columns.ts` renders the `stage` column from `row.stage` (a catalogue DB column).

New: render from `board.pills[]` (first pill's label). Same fallback chain as render-tab.

Change:
```ts
// current
export function stageColumn(row: CatalogueRow): string {
  return row.stage ?? "";
}

// new
export function stageColumn(row: CatalogueRow): string {
  if (!row.cluster) return row.stage ?? "";  // no cluster → catalogue fallback
  const idx = boardIndex(row.cluster);
  const hit = idx.bySession(row.sessionId);
  if (hit && hit.row.pills.length > 0) return hit.row.pills[0].label;
  return row.stage ?? "";  // board miss → catalogue fallback
}
```

TUI stays synchronous (indexer is sync). Filter/sort operations that groupby stage continue to work — they consume the returned string, and the vocabulary is stable per cluster.

---

## 7. Default composer

Clusters without a `board` entry in cluster.toml get a trivial default: copy every catalogue row keyed on identity, one pill named after the row's stage. Ensures no cluster loses its board when ccs upgrades.

```ts
// src/board/default-composer.ts
export function runDefaultComposer(cluster: string, opts: { identity?: string } = {}): void {
  const catalogueDb = openCatalogue(CATALOGUE_PATH());
  const rows: BoardRow[] = [];
  for (const [sid, catRow] of getAll(catalogueDb)) {
    if (catRow.cluster !== cluster) continue;
    const identity = identityKeyOf(catRow);
    if (!identity) continue;
    if (opts.identity && identity !== opts.identity) continue;
    rows.push({
      identity,
      workUnit: { kind: catRow.pr_number ? "pr" : "gus", ...catRow.workUnit },
      sessions: [{ sessionId: sid, isPrimary: true, lastActivity: catRow.updatedAt ?? "" }],
      pills: catRow.stage ? [{ key: "ccs_lifecycle", label: catRow.stage, priority: 50 }] : [],
      description: catRow.statusLine ?? null,
      alerts: [],
      awaitingFrom: [],
      lastComposed: new Date().toISOString(),
    });
  }
  const board: Board = {
    status: "OK",
    provenance: { source: "ccs-default-composer", at: new Date().toISOString() },
    rows,
  };
  // single-row mode: merge into existing board.json
  if (opts.identity) {
    const current = readBoard(cluster) ?? { status: "OK", provenance: board.provenance, rows: [] };
    const filtered = current.rows.filter(r => r.identity !== opts.identity);
    board.rows = [...filtered, ...rows];
  }
  writeBoard(cluster, board);
}
```

Invoked whenever `cluster.toml` has no `board` entry.

---

## 8. `cluster.toml` — `board` entry

New optional field, alongside `sense`:

```toml
# ~/.ccs-config/clusters/pr-watch/cluster.toml
sense = "engine/scripts/sense.sh"
board = "engine/scripts/compose_board.py"    # NEW; optional (default composer if absent)
```

Loaded by the existing cluster-manifest reader; passed to `ccs board <c> --recompose <key>` as the composer entrypoint. Absolute or package-relative (same rules as `sense`).

---

## 9. Freshness contract in ccs commands

Every ccs command that WRITES state a consumer will render must call `--recompose <key>` synchronously before returning. Concrete surfaces:

- `ccs meta <sid> <key> <value>` — after the write, if the value changes stage-relevant meta (e.g. `milad_review`), recompose. Concretely: recompose if `key` is in a cluster-configured set (defaulted to `["milad_review", "build_complete"]`, tunable in cluster.toml). Cheap enough to always recompose — one row.
- `ccs stage <sid> <value>` — always recompose (stage changed, by definition).
- `ccs status <sid> "..."` — always recompose (description changed).
- `ccs sync-tabs <sid>` — recompose BEFORE painting. Every existing usage of sync-tabs already implies "I want the tab to reflect current state."
- Any `pushRenderOps` call in the codebase — either drop the direct catalogue read and go through board, or trigger a recompose first.

Skip on `--dry-run` variants of any command.

Failure of the recompose is logged but doesn't fail the command — the tab paints stale, and the next tick's whole-board recompose catches up. Loud log at `WARN` so we notice a broken composer.

---

## 10. Migration order (ccs side)

Matches ADR-0077's 7-step path from the tool side:

1. **Types + paths + indexer + default composer land.** No behavior change. Ship as a library the rest can call.
2. **`ccs board <c> --identity <key>` + `--recompose <key>` land.** Still nothing renders from board.
3. **`renderTab` switches to reading pills from board, falling back to catalogue.stage.** First user-visible change. cmux sidebar starts showing composed pills for clusters that provide a composer.
4. **Alert pills added.** Hard alerts appear as additional cmux pills (color-coded).
5. **TUI stage column switches to reading board.** Same fallback rule.
6. **Description overlay switches to preferring board.description over catalogue.statusLine.**
7. **`catalogue.stage` DB column deleted.** Once no code path reads it, drop the column via schema migration. All fallbacks removed.

Each step is independently deployable; back out by reverting its commit.

---

## 11. Test surface

### Unit tests

- `src/board/indexer.test.ts` — indexer builds correct maps from a fixture board.json; `bySession` uses the catalogue mock; mtime-based cache invalidation works; missing file returns null.
- `src/board/default-composer.test.ts` — golden fixture: given a small catalogue, assert the composed board.json byte-for-byte.
- `src/catalogue/render-tab.test.ts` — extend existing tests: with a fixture board, `computePillsFromBoard` returns the composed pills; without a board, falls back to `computePhasePill`; with a board that has hard alerts, `alertPills` emits an extra pill.
- `src/tui/columns.test.ts` — `stageColumn` reads from board; falls back to `row.stage` on board miss.

### Integration tests

- `ccs board <c> --identity <key>` on a fixture with 2 identities → returns the target row only, exits 0.
- `ccs board <c> --recompose <key>` invokes the cluster composer with the right argv; recomposed row updates in-place; other rows untouched (byte-identical).
- `ccs board <c> --session <sid>` resolves and forwards; error path for a session with no identity.
- Cluster with no `board` entry → default composer runs; board.json has one row per pr-agent catalogue row.

### End-to-end smoke (against the ccs-config pr-watch cluster)

- Run `ccs board pr-watch --json` → assert schema validity.
- `ccs meta <sid> milad_review approved` → assert board row's pills flip to the next stage's label (via the composer, which pr-watch owns) synchronously.
- `ccs sync-tabs <sid>` → assert board row's `lastComposed` timestamp advanced before repaint.

---

## 12. Non-goals

- **No webhook receiver.** Freshness is via baseline poll + event-triggered synchronous recompose only.
- **No auto-actions on GitHub.** Un-draft, request-review, merge — all cluster commands, all require explicit human triggers.
- **No cluster-specific rendering.** No hardcoded pr-watch color for "milad-review" pills; the cluster's composer supplies colors.
- **No writes to catalogue.stage from ccs.** During migration ccs READS it as a fallback; the cluster's composer owns writes to its own state (and after §7 completes, the column is gone).
- **No board.json for identities across clusters in one file.** Every cluster owns its own board.json under `~/.ccs/clusters/<c>/cluster/board.json`. Cross-cluster queries are a future concern.
