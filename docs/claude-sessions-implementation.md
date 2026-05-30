> **This plan was created using the `plan-new` skill.**
> To resume work on this project, use the `plan-resume` skill which provides
> the structured workflow for loading context, verifying state, and continuing
> from where the last agent left off.

# claude-sessions (`ccs`) - Project Tracker

**Project**: claude-sessions — a global TUI to find and resume any Claude Code session
**Owner**: Milad
**Started**: 2026-05-29
**Status**: Planning Complete

> Read `CONTEXT.md` (glossary) and `docs/adr/0001-codex-for-title-generation.md` before
> writing code. The glossary terms (Session, Store, Host, Index, Title, Project, Resume,
> Resume Target, Workspace) are canonical — use them exactly in code and comments.

---

## Project Overview

### Goal
A single-machine Bun/TypeScript + Ink TUI, invoked as `ccs`, that browses and resumes any
Claude Code Session on the local Host regardless of the directory it started in — fixing the
fact that Claude Code's own `--resume` picker is scoped to the current directory. It is the
read-only foundation for a later Session-cataloguing/tagging layer (out of scope here).

### Success Criteria
- [ ] `ccs` launches a TUI listing every Session in the Store, newest first, in <1s.
- [ ] Each Session shows an LLM-generated Title (Codex), with a cleaned-first-message fallback shown immediately while Titles backfill in the background.
- [ ] `/` search finds Sessions by Title/Project (fuzzy) and by content (FTS over the stored skeleton).
- [ ] `g` toggles a group-by-Project view; Projects collapse repo-root + subdir Sessions together.
- [ ] `↵` resumes the selected Session in its recorded `cwd`; `f` forks it. In cmux, resume opens a new named Workspace; otherwise it hands off the current terminal.
- [ ] `ccs reindex [--titles]` runs headless (launchd/cron-able) and incrementally refreshes the Index.
- [ ] Onboarding a new machine is `git clone` → `bun install` → `bun run setup` → `ccs` on PATH.
- [ ] `bun run typecheck` and `bun test` pass; no `any`.

---

## Implementation Milestones

### **Milestone 1: Scaffold, config, and Store discovery**
**Goal**: A runnable `ccs` binary that loads config, identifies the Host, locates the Store, and reports how many Session files it can see.

**Tasks**:
- [ ] Init Bun project: `package.json`, strict `tsconfig.json` (no `any`), `.gitignore`, `bin/ccs` (`#!/usr/bin/env bun`).
- [ ] Add deps: `ink`, `react`, `bun:sqlite` (built-in), a fuzzy matcher (e.g. `fuzzysort`), a TOML parser (`smol-toml`), and `zod` for config/boundary validation.
- [ ] `src/config.ts`: load/merge `~/.claude-sessions/config.toml` over defaults; zod-validate; expose typed `Config`. Keys: `store.path` (default `~/.claude/projects`), `host.label` (default `os.hostname()`), `resume.target` (`auto`|`cmux`|`inline`, default `auto`), `titler.model`, `titler.concurrency` (default 3).
- [ ] `src/paths.ts`: resolve data dir `~/.claude-sessions/` (config + `index.db`); create lazily.
- [ ] `src/store.ts`: enumerate `*.jsonl` Session files under the Store; `stat` for size/mtime. Return `StoredSessionFile[]`.
- [ ] `src/cli.ts`: arg routing — bare `ccs` (TUI, stubbed for now), `ccs reindex`, `ccs --version`, `ccs --help`.
- [ ] `ccs reindex` prints discovered Session count + total size (no DB yet).

**Success Criteria**:
- `ccs --version` works; `ccs reindex` prints "Found 163 sessions (298 MB) in <store>".
- Config file absent → defaults used; malformed config → clear zod error, non-zero exit.
- `bun run typecheck` passes.

**Completion Notes**:
```
Date: 2026-05-29
Status: COMPLETED (pending user verification)

Notes:
- Bun project scaffolded: package.json (type:module, bin ccs -> bin/ccs),
  strict tsconfig (noUncheckedIndexedAccess, verbatimModuleSyntax, etc.), .gitignore.
- Deps installed: only what M1 uses — zod@4.4.3, smol-toml@1.6.1 (+@types/bun, typescript).
  Ink/React/fuzzysort deliberately deferred to their milestones (M4) to keep installs lean.
- src/result.ts: Result<T,E> + ok/err for boundary error handling.
- src/paths.ts: DATA_DIR ~/.claude-sessions, CONFIG_PATH, DB_PATH, DEFAULT_STORE_PATH
  (~/.claude/projects), ensureDataDir(), expandHome().
- src/config.ts: TOML load + zod validation + defaults. Keys: store.path, host.label,
  resume.target (auto|cmux|inline), titler.model, titler.concurrency. ~-expansion on store.path.
- src/store.ts: scanStore() — Bun.Glob recursive **/*.jsonl, stat-only (no content reads);
  formatBytes().
- src/cli.ts: arg routing — --version, --help, reindex [--titles], bare (TUI stub), unknown->exit 1.
- bin/ccs: #!/usr/bin/env bun shim, chmod +x.

Test Results:
- bun run typecheck: clean.
- bun test: 5 pass / 0 fail (formatBytes scaling; config defaults/override/~-expand/invalid-enum).
- ./bin/ccs --version -> 0.1.0
- ./bin/ccs reindex -> "Found 172 sessions (298.3 MB) in /Users/mimen/.claude/projects
  [host: Milads-M3-2.local]"  (172 not 163 — new sessions created since the design scan;
  recursive glob also catches the few nested session dirs)
- ./bin/ccs reindex --titles -> same + M3 stub line
- bare ./bin/ccs -> TUI stub line; ./bin/ccs bogus -> exit 1

Issues encountered:
- Zod 4 behavior change: .default({}) on a nested object stores the literal {} WITHOUT
  re-parsing, so inner field defaults didn't apply (store.path came back undefined) and the
  input type demanded all fields (TS overload errors). Fixed by switching the four nested
  objects to .prefault({}), which feeds {} as input and parses it, applying inner defaults.
  Both the type errors and the runtime undefined resolved in one change.

Next steps:
- Milestone 2: src/parse.ts (head/tail extraction), label.ts, skeleton.ts, project.ts
  (git-root walk), src/index/{schema,index}.ts (bun:sqlite + FTS5, incremental upsert),
  wire reindex to populate the Index, add hidden `ccs ls` debug table.
```

---

### **Milestone 2: Session parser and SQLite Index**
**Goal**: An incremental Index of Session metadata, rebuildable from the Store, queryable for the browse list.

**Tasks**:
- [ ] `src/parse.ts`: read each Session file's head (first ~20 lines) and tail (last ~10 lines) only — never load whole 66 MB files. Extract: `sessionId`, `cwd`, `gitBranch`, `version`, first + last timestamps, message count (cheap line scan), first substantive user message.
- [ ] `src/label.ts`: clean the first user message into a fallback label — strip `<command-message>`/`<command-name>` wrappers, leading pasted file paths, attachment noise; if it's a bare slash-command, use the command name; truncate ~80 chars.
- [ ] `src/skeleton.ts`: build the bounded titler/search skeleton — first ~6 + last ~2 text turns, tool calls/outputs reduced to one-line stubs, hard cap ~3-4k tokens.
- [ ] `src/project.ts`: derive Project — walk up from `cwd` to nearest `.git`; fallback to `cwd` when no repo or path missing. Cache resolved repo-roots per cwd.
- [ ] `src/index/schema.ts`: `bun:sqlite` schema — `sessions` table (id, host, cwd, project_root, project_name, branch, version, first_ts, last_ts, msg_count, file_mtime, file_size, fallback_label, title, title_msg_count, title_attempts, skeleton) + FTS5 virtual table over `title` + `skeleton`. Add a `schema_version` pragma for safe rebuilds.
- [ ] `src/index/index.ts`: incremental upsert — only re-parse Session files whose mtime/size changed since the indexed row; expose query API (`listByRecency`, `listByProject`, `search`, `get`).
- [ ] Wire `ccs reindex` to populate the Index; add a hidden `ccs ls` debug command printing rows as a table.

**Success Criteria**:
- `ccs reindex` builds `~/.claude-sessions/index.db`; second run re-parses ~0 files (incremental).
- `ccs ls` shows Title(empty)/fallback, Project (repo names, not encoded paths), branch, age, msg count.
- `convex-db` and `convex-db/app` Sessions collapse under one `convex-db` Project.
- Deleting `index.db` and re-running fully reconstructs it.
- `bun test` covers label-cleaning + project-derivation edge cases.

**Completion Notes**:
```
Date: 2026-05-29
Status: COMPLETED (pending user verification)

Notes:
- MAJOR FINDING mid-milestone: Claude Code 2.1.156 already writes native `ai-title` lines
  (59/172 sessions). Surfaced to user; decided Native-first, Codex fills gaps. Amended
  ADR-0001 and CONTEXT.md (Title + new Native Title term). Title resolution priority:
  native ai-title → codex_title → cleaned-first-message.
- src/parse.ts: single streaming pass (node:readline), bounded memory (first-8 + rolling
  last-4 skeleton turns, first-4 user texts) so 66 MB files never load whole. Captures cwd,
  gitBranch, version, first/last ts, msgCount, nativeTitle (last ai-title wins), userTexts,
  skeleton. Tolerates corrupt lines. Message content handled as string OR block array;
  tool_use→"[tool: name]", tool_result→"[tool result]", thinking omitted.
- src/label.ts: cleanLabel(userTexts) — strips <command-*>/<local-command-*>/stray tags,
  surfaces bare/stubbed slash-commands as their name, walks/strips leading pasted file-path
  lines (spaces allowed; blank-line/path-line heuristic), truncates 80 chars, "(untitled)".
- src/project.ts: deriveProject(cwd) — nearest-.git walk, cwd fallback (non-repo or missing
  path), per-cwd cache. clearProjectCache() for tests.
- src/index/schema.ts: bun:sqlite, WAL, user_version=1 (drop+recreate on mismatch — pure
  cache). sessions table + native_title/codex_title/fallback_label/title_msg_count/
  title_attempts + skeleton; FTS5 sessions_fts(title, skeleton); indexes on last_ts, project.
- src/index/index.ts: reindexStore() incremental (skip unchanged mtime+size; preserve
  titler-owned cols on re-parse; delete vanished rows; sync FTS). listByRecency(), search()
  (COALESCE title resolution + titleSource). search() builds prefix-OR FTS query.
- cli.ts: reindex now populates Index + prints parsed/unchanged/removed; added `ccs ls`
  debug table (★ native, ✎ codex, blank fallback). formatAge() added to store.ts.

Test Results:
- typecheck clean; bun test 18 pass / 0 fail (parse, label, project, config, store).
- Cold reindex: 172 sessions / 299.4 MB in 1.7s. Warm: 0.08s, 1 parsed / 171 unchanged.
- Repo collapse verified: milad-vault = 34 sessions across 5 cwds → 1 Project.
- Title sources: 59 native / 113 fallback (need Codex in M3).
- FTS "ynab" returns the YNAB session + body-mentions. Full rebuild from deleted db: OK.

Issues encountered:
- Zod-4-style nothing here; the label path-stripper first regex required no-spaces and
  missed "Artworks June 13" (spaces in path). Rewrote to walk leading path-like lines
  (start with / or ~, single line, no sentence punctuation). Fixed.
- KNOWN REFINEMENT for M4: search() outer query re-sorts FTS hits by last_ts, so a
  title match isn't ranked above a body-only mention. The proper fuzzy-title + FTS-skeleton
  merge with relevance ranking is M4 (search UI) scope — table + query plumbing is done here.
- Cosmetic: `ls` prints msgCount as "461m" (m=messages) which reads like minutes; `ls` is a
  throwaway debug view, real columns come in M4.

Next steps:
- Milestone 3: src/titler/{codex.ts,schema.json,queue.ts}. Generate codex_title ONLY for
  the 113 sessions where native_title IS NULL; persist title + title_msg_count; retry/backoff
  via title_attempts; update FTS title on generation; `ccs reindex --titles` headless drain;
  staleness re-title when msg_count > 1.5× title_msg_count.
```

---

### **Milestone 3: Codex titler + background backfill**
**Goal**: LLM-generated Titles cached in the Index, generated hermetically via Codex, backfilled without blocking, incrementally and resiliently.

**Tasks**:
- [ ] `src/titler/codex.ts`: single `Titler` interface; Codex impl shells `codex exec --ephemeral --skip-git-repo-check --sandbox read-only --ignore-rules --ignore-user-config --output-schema <title-schema.json> --output-last-message <tmp> -m <model>`, skeleton piped via stdin. Parse `{ "title": string }`. (Interface keeps the ADR's swap-out promise.)
- [ ] `src/titler/schema.json`: JSON Schema forcing `{ "title": "<=80 chars" }`.
- [ ] `src/titler/queue.ts`: throttled queue (concurrency from config, default 3) over un-titled/stale Sessions; persist Title + `title_msg_count`; on failure increment `title_attempts`, keep fallback, retry with exponential backoff, skip after N attempts.
- [ ] Staleness: enqueue for re-title when `msg_count > 1.5 × title_msg_count`.
- [ ] `ccs reindex --titles`: headless drain of the queue to completion (for launchd/cron); plain reindex leaves Titles to the TUI background drain.
- [ ] Tests: skeleton stays under cap for a synthetic 66 MB-shaped file; queue retries and respects concurrency (mock Titler).

**Success Criteria**:
- `ccs reindex --titles` populates Titles for all Sessions; rerun titles ~0 (already current).
- A deliberately failing Titler leaves fallback labels intact and the run still completes.
- Titles are recognizable (e.g. "Freakuency budget report", not the raw first message).

**Completion Notes**:
```
Date: 2026-05-29
Status: COMPLETED (pending user verification)

Notes:
- src/titler/codex.ts: Titler interface + createCodexTitler(). Bun.spawn of `codex exec`
  (no shell, so the user's `codex` alias and its --dangerously-bypass flag DON'T apply —
  we pass explicit --sandbox read-only). Flags: --ephemeral --skip-git-repo-check
  --sandbox read-only --ignore-rules --ignore-user-config -c model_reasoning_effort="low"
  --output-schema schema.json --output-last-message <tmp>. Skeleton piped via stdin;
  prompt passed as arg. 60s timeout (proc.kill). Returns null on any failure.
- src/titler/schema.json: {title:string} structured-output schema.
- src/titler/queue.ts: backfillTitles() — async worker pool at config concurrency; success
  -> saveCodexTitle, failure -> recordTitleFailure; never throws out of the drain.
- src/index/index.ts: titleCandidates() (native_title IS NULL, attempts<cap, stale-or-untitled),
  saveCodexTitle() (sets codex_title + title_msg_count, resets attempts, refreshes FTS),
  recordTitleFailure() (++attempts).
- cli.ts: `reindex --titles` builds the Codex titler from config and drains with a live
  N/total progress line. Plain reindex leaves titling to M4's TUI background drain.
- config.ts titler block: binary("codex"), model("" = inherit Codex default — account-safe),
  reasoningEffort("low"), concurrency(3), maxAttempts(3).

KEY DECISIONS proven against reality:
- Do NOT hard-code a model. gpt-5-mini is rejected on a ChatGPT-account Codex
  ("model not supported"). Empty model inherits the user's configured default (gpt-5.5
  here), which is guaranteed valid for their plan. reasoningEffort=low avoids the default
  xhigh (saves time/tokens). Titles ~5-8s each; ~14k tokens each (no marginal $ on ChatGPT).
- Staleness re-title: msg_count > 1.5 × title_msg_count.

Test Results:
- typecheck clean; bun test 22 pass / 0 fail (4 new queue tests: native-skip, concurrency
  cap, failure/attempt-cap, staleness — all with a mock Titler, no real codex).
- REAL end-to-end: `ccs reindex --titles` generated 113/113 titles, 0 failed, in 4:07
  (concurrency 3). Re-run: 0 generated / 0 failed (idempotent).
- Title quality (samples): "Audit Gabss planning team logins", "Map Event Permission Model",
  "Verify Tanya Venmo Payment", "Audit Convex codebase hardening opportunities". Good.

Issues encountered:
- gpt-5-mini unsupported on ChatGPT-account Codex (caught in smoke test). Resolved by the
  inherit-default approach above; amended config default away from gpt-5-mini.
- Codex's default xhigh reasoning is overkill/slow for titling -> forced low via -c.

Next steps:
- Milestone 4: Ink TUI. Add deps ink/react/fuzzysort. src/tui/{App,SessionList,Preview}.tsx,
  search.ts, groupByProject.ts. Flat recency default, `g` group-by-Project, `/` search
  (fuzzy title/project + FTS skeleton WITH relevance ranking — the M2 ranking refinement
  lands here), `p` preview, `t` manual re-title, background title drain while open.
```

---

### **Milestone 4: TUI — browse, search, preview**
**Goal**: The daily-driver screen: flat recency list, group-by-Project toggle, live search, preview pane, with Titles upgrading live as the background drain runs.

**Tasks**:
- [ ] `src/tui/App.tsx`: Ink app shell, key handling, view state (list | grouped | searching), graceful resize.
- [ ] `src/tui/SessionList.tsx`: columns Title · Project · Branch · Age; default sort most-recent-first; selection + scrolling.
- [ ] `src/tui/groupByProject.ts` + view: `g` toggles collapsible Project groups (most-recent-first, session counts; `↵`/`→` expand).
- [ ] `src/tui/search.ts`: `/` opens search; fuzzy match on Title/Project, FTS on skeleton; merge + rank; live filter.
- [ ] `src/tui/Preview.tsx`: `p` detail pane — full `cwd`, branch, model(s), msg count, size, first/last timestamps, UUID; first message + last user↔assistant exchange.
- [ ] Background title drain runs while TUI is open (M3 queue), pushing live row updates; `t` = manual re-title selected.
- [ ] Footer keybar; `q`/Esc quit.

**Success Criteria**:
- `ccs` renders all Sessions <1s; Titles fill in visibly over the following minutes on a cold Index.
- Search narrows by name and by remembered content phrase.
- `g` groups by Project and back; `p` preview correctly identifies a Session; `t` re-titles.

**Completion Notes**:
```
Date: 2026-05-29
Status: COMPLETED (pending user verification)

Notes:
- Ink TUI (deps ink@7, react@19, fuzzysort@3). src/tui/App.tsx (shell/state/keys/background
  drain), SessionList.tsx (scrolling list, source marks ★/✎/·, subagent ↳ + dim),
  Preview.tsx (full detail + skeleton peek + parent/subagent info), search.ts (fuzzy
  name + FTS content, relevance-ranked — the M2 ranking fix), groupByProject.ts
  (groups + buildDisplayItems flat/grouped). cli bare `ccs` → launchTui (incremental
  reindex on launch, then render; dynamic import of ink/react/App).
- Keys: ↑↓/j/k move, ↵ expand(header)/resume(session, placeholder until M5), / search,
  g flat/grouped, p preview, a show/hide subagents, t retitle, q/esc quit.
- BIG mid-milestone additions (per user, both surfaced from real-data findings):
  1. SUBAGENT FILTERING. 98/172 store entries are pure subagent runs (every msg isSidechain).
     parse.ts flags isSubagent; schema v2 added is_subagent; queries hide them by default,
     `a` toggles. listByRecency/search take includeSubagents.
  2. PARENT LINKAGE. Subagent files live at <cwd>/<PARENT_ID>/subagents/agent-*.jsonl and
     carry the parent's sessionId internally (NOT via parentUuid — verified). parse.ts
     captures parentSessionId; schema v3 added parent_session_id; subagentCounts() query;
     Preview shows "spawned by <parent>" / "N subagent runs". Interactive drill-down UX
     deferred to new milestone (see M7 / task #2).
- Schema went v1→v2→v3 this milestone; each bump drops+rebuilds (pure cache). Re-titled
  after: only 15 real non-native sessions need Codex now (subagents excluded), ~1 min.

Test Results:
- typecheck clean; bun test 31 pass / 1 skip / 0 fail.
- search.test (rank: name-match > content-only, fuzzy typos), groupByProject.test
  (order, flat vs grouped/expanded), parse.test (subagent detection + mixed = not subagent).
- REAL BINARY PTY-verified: `script(1)` → ccs → `q` exits 0, ~47KB rendered frame.
- Real index: 172 indexed, 74 real shown by default, 98 subagent runs hidden.

Issues encountered:
- ink-testing-library + Bun renders the full App blank (bare <Box>/<Text> render fine; App
  with useInput does not). Test-harness interaction, not a product bug — confirmed via the
  PTY smoke. That one mount test is test.skip with a pointer to the PTY verification.
- Tooling note: shell output channel was intermittently dropping/echoing phantom lines during
  this milestone; verified results via exit codes + file reads to stay honest.

Next steps:
- Milestone 5: real resume. src/resume/{command,target,cmux,inline}.ts; wire ↵/f in App to
  actually hand off (inline) or open a cmux workspace; missing-cwd guard.
```

---

### **Milestone 5: Resume — inline hand-off, fork, cmux target**
**Goal**: `↵`/`f` reliably drop you into a live `claude` session in the right `cwd`, via cmux when present, inline otherwise.

**Tasks**:
- [ ] `src/resume/command.ts`: build the canonical invocation from Session metadata — `claude --resume <id>` (+`--fork-session` for fork). Never trust a printed hint.
- [ ] `src/resume/target.ts`: detect target — `cmux ping` reachable (and `resume.target` not pinned to `inline`) → cmux; else inline. Respect `resume.target` pin and an in-TUI override key (`o`).
- [ ] `src/resume/cmux.ts`: `cmux new-workspace --name "<Title or fallback>" --cwd "<cwd>" --command "<resume cmd>" --focus true` (+ `--description` with branch/project).
- [ ] `src/resume/inline.ts`: unmount Ink, restore terminal, `spawnSync('claude', args, { cwd, stdio: 'inherit' })`, exit with its code.
- [ ] Missing-cwd guard: if `cwd` is gone, warn and offer repo-root (if findable) or `$HOME`; never silently launch in the wrong place.
- [ ] Tests: command construction (in-place vs fork), target selection given mocked `cmux ping` + config pin, missing-cwd branch.

**Success Criteria**:
- In cmux: `↵` opens a new Workspace named by Title, in the right `cwd`, resuming the Session.
- Outside cmux: `↵` hands off the terminal; on quitting Claude you're back at your shell cleanly.
- `f` forks (original file untouched, new session id created). `o` forces the other target.
- Resuming a Session whose `cwd` was deleted prompts instead of failing.

**Completion Notes**:
```
Date:
Status:
Notes:
Test Results:
Issues encountered:
Next steps:
```

---

### **Milestone 6: Distribution, polish, docs**
**Goal**: Clone-and-go onboarding, optional full-transcript view, and a README.

**Tasks**:
- [ ] `scripts/setup.ts` + `bun run setup`: `bun link` so `ccs` lands on PATH; verify `claude` and (optionally) `codex`/`cmux` presence, warn if missing.
- [ ] `src/tui/Transcript.tsx` (stretch): `v` opens a scrollable rendered transcript of the selected Session.
- [ ] `README.md`: install, onboarding a new Host, config reference, the cmux/codex/claude dependencies, and how to rebuild the Index.
- [ ] First-run UX: if Index empty, kick a reindex with a friendly "indexing N sessions…" line.
- [ ] Confirm `bun run typecheck` + `bun test` green; quick manual pass on the Mac Mini if convenient.

**Success Criteria**:
- Fresh clone → `bun install` → `bun run setup` → `ccs` works with zero config.
- README is enough for future-you on a new machine.
- (If built) `v` renders a readable transcript.

**Completion Notes**:
```
Date:
Status:
Notes:
Test Results:
Issues encountered:
Next steps:
```

---

## Progress Tracking

**Overall Completion**: 4/7 milestones (57%)

- [x] Planning & Research (grill: CONTEXT.md + ADR-0001 written)
- [x] Milestone 1: Scaffold, config, Store discovery
- [x] Milestone 2: Session parser and SQLite Index
- [x] Milestone 3: Codex titler + background backfill
- [x] Milestone 4: TUI — browse, search, preview (+ subagent filtering + parent linkage data)
- [ ] Milestone 5: Resume — inline, fork, cmux target
- [ ] Milestone 6: Distribution, polish, docs
- [ ] Milestone 7: Subagent drill-down UX (expand a session into its agent tree)

---

## File Inventory

### Files to Create
- [ ] `package.json`, `tsconfig.json`, `.gitignore`, `bin/ccs` — project scaffold
- [ ] `src/config.ts` — TOML config load + zod validation + defaults
- [ ] `src/paths.ts` — data-dir resolution (`~/.claude-sessions/`)
- [ ] `src/store.ts` — Store enumeration + stat
- [ ] `src/cli.ts` — arg routing (`reindex`, `--version`, bare TUI)
- [ ] `src/parse.ts` — head/tail Session metadata extraction
- [ ] `src/label.ts` — fallback-label cleaning
- [ ] `src/skeleton.ts` — bounded titler/search skeleton
- [ ] `src/project.ts` — git-root Project derivation + cache
- [ ] `src/index/schema.ts` — SQLite + FTS5 schema, schema_version
- [ ] `src/index/index.ts` — incremental upsert + query API
- [ ] `src/titler/codex.ts` — Titler interface + Codex impl
- [ ] `src/titler/schema.json` — structured-output schema
- [ ] `src/titler/queue.ts` — throttled backfill queue + retry/backoff
- [ ] `src/tui/App.tsx`, `SessionList.tsx`, `Preview.tsx`, `search.ts`, `groupByProject.ts` — TUI
- [ ] `src/tui/Transcript.tsx` — full transcript view (stretch, M6)
- [ ] `src/resume/command.ts`, `target.ts`, `cmux.ts`, `inline.ts` — resume
- [ ] `scripts/setup.ts` — `bun link` onboarding
- [ ] `README.md` — install + usage
- [ ] `src/**/*.test.ts` — unit tests per module

### Files to Modify
- [ ] `CONTEXT.md`, `docs/adr/*` — extend if new terms/decisions surface during build
- [ ] `docs/claude-sessions-implementation.md` — completion notes after each milestone

---

## Key Technical Decisions

### Title generation via Codex, not Claude
See `docs/adr/0001-codex-for-title-generation.md`. Avoids imminent Claude API credit cost; runs hermetically; behind a `Titler` interface for easy swap.

### SQLite Index as a pure, rebuildable cache
**Problem**: Re-reading 298 MB of JSONL every launch is too slow; the catalog phase needs somewhere to store Titles/tags.
**Solution**: `bun:sqlite` Index at `~/.claude-sessions/index.db`, incrementally refreshed, fully reconstructable from the Store.
**Alternatives**: Stateless live-scan (no place for Titles/tags; rewrite later). JSON file (no FTS, no incremental query).
**Rationale**: Zero-dep (Bun built-in), instant warm launches, exact substrate for the future catalog layer.

### Project = git repo root, not raw cwd
**Problem**: Claude Code groups by exact `cwd`, fragmenting one repo across root + subdir folders.
**Solution**: group by nearest `.git` ancestor; fallback to `cwd` when not in a repo or path is gone.
**Rationale**: Matches the mental model you navigate by; cheap and cached.

### Resume builds its own invocation; target auto-detected
**Problem**: The CLI's printed end-of-session resume hint sometimes fails (failure mode D); picker is cwd-scoped.
**Solution**: construct `claude --resume <id>` from metadata and run it in the recorded `cwd`; pick cmux Workspace vs inline hand-off automatically.
**Rationale**: Fixes find-it (A), wrong-cwd (B), and bad-hint (D) directly; cmux gives named Workspaces for free via the Title.

### Bun + TypeScript + Ink, `bun link` distribution
Matches the toolchain on every Host; no per-arch compiled binaries; keeps the future catalog layer in one language/codebase.

---

## Known Edge Cases

1. **Huge Session files (66 MB)**: never full-read — head/tail parse + bounded skeleton. **Testing**: synthetic large file stays fast and under the token cap.
2. **Session `cwd` deleted/moved**: Project falls back to `cwd` string; resume prompts for an alternate dir. **Testing**: point a row at a nonexistent path.
3. **First user "message" is a slash-command or pasted path**: label cleaning detects and handles. **Testing**: fixtures from real Store samples (`/finance-session-startup`, `Artworks June 13` path).
4. **Titler unavailable (`codex` missing / offline)**: fallback labels persist; retries with backoff; `setup` warns. **Testing**: mock a failing Titler.
5. **cmux not running / not installed**: `cmux ping` fails → inline hand-off. **Testing**: target selection with mocked ping.
6. **Stale Index after a Session grows (resumed)**: incremental re-parse on mtime change; re-title past the growth threshold.
7. **Corrupt/partial JSONL line**: parse defensively per-line; skip bad lines, never crash the scan.
8. **Multiple machines, synced index (future)**: every row carries `host`; v1 operates only on local rows.

---

## Notes & Learnings

### Development Notes
```
Verified on 2026-05-29 (claude 2.1.156, codex-cli 0.130.0, cmux 0.64.3):
- Store is the ONLY session location: ~/.claude/projects/ (163 sessions, 298 MB). Scattered
  .claude dirs hold config, never transcripts.
- Session JSONL line keys include: cwd, sessionId, version, gitBranch, timestamp, parentUuid,
  isSidechain, type. No inline "summary" lines in this CC version.
- claude flags: --resume [id], --continue, --fork-session, -n/--name.
- codex exec flags confirmed: --ephemeral, --sandbox read-only, --ignore-rules,
  --ignore-user-config, --output-schema, --output-last-message, -m.
- cmux: `cmux new-workspace --name --cwd --command --focus`; `cmux ping` for detection.
```

### Issues Encountered
```
- Open thread (harness task #1): reproduce the broken end-of-session resume command
  (failure mode D). Deferred; does not block v1 since we construct our own invocation.
```

### Future Enhancements (catalog phase — out of scope)
- [ ] Tag/categorize Sessions against the Obsidian mindmap entity taxonomy.
- [ ] Use Sessions as retrievable context for new Sessions.
- [ ] Full raw-body FTS (extend the existing FTS table).
- [ ] Cross-Host browse (merge synced per-Host indexes; resume Mini sessions over `ssh macmini`).
- [ ] Resume de-dup (focus an existing Workspace already running a Session).
- [ ] Lineage grouping (collapse fork/continuation chains).

---

## References

**Key Files**:
- `CONTEXT.md` — canonical glossary
- `docs/adr/0001-codex-for-title-generation.md` — the Codex decision

**Commands**:
```bash
bun install
bun run typecheck
bun test
bun run setup        # bun link → ccs on PATH
ccs                  # launch TUI
ccs reindex --titles # headless index + title backfill (launchd/cron)
```

---

**Last Updated**: 2026-05-29 (initial plan created via plan-new after grill-with-docs)
