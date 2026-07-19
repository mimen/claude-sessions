# Features to salvage from origin/master before making local master canonical

**Date:** 2026-07-18
**Context:** origin/master and local master diverged from `1c1ec3e`. Local
master (ADR-0089 identity refactor + Phase 1 hardening, 293 commits) is the
production direction for pr-watch. Origin master (12 commits, `catalogue-v5 /
Merged-View / role-edge / substrate / lineage`) is a parallel experiment
that reshaped ccs into a general multi-agent session browser and deletes
the pr-watch specialization.

**Plan:** curate the interesting bits from origin, reimplement them fresh
on our shape, then force-push local master over origin. No merge, no
partial integration.

Preservation: origin's current tip will be pushed to
`preservation/fleet-view-2026-07-18` before force-push, so nothing is lost.

## The salvage list (ranked most to least worth taking)

### Rank A — take these, small and pure additive

#### A1. Durable crash logging (`crashlog.ts`)
- **Source:** `81bca79 feat: durable crash logging — fullscreen Ink wipes stack traces on exit`
- **Files:** `src/crashlog.ts`, hook in `src/cli.ts:main()`
- **What it does:** installs `uncaughtException` / `unhandledRejection` handlers that (1) restore the terminal (leave alt-screen, cursor back, raw mode off), (2) append the full stack + version + argv to `~/.claude-sessions/crash.log`, (3) still print to stderr. `CCS_DEBUG=1` adds a breadcrumb trail to `ccs-debug.log`.
- **Why we want it:** fullscreen Ink TUI wipes stack traces on exit; today when the TUI crashes you get zero diagnostics. This is pure add, no schema change, ~50 lines.
- **Effort:** ~30 min.

#### A2. Round-trip resume-cwd guard (`resume/locate.ts`)
- **Source:** `d1dee30 fix(resume): real round-trip guard — reject false matches, surface ambiguity` and follow-up `322f77e`
- **Files:** `src/resume/locate.ts`, `src/resume/command.ts` in shape adjusted for our repo
- **What it does:** when resuming by cwd-encoded folder name, walks the encoding candidates and *round-trip-verifies* — `encode(realpath(candidate))` must equal the folder — instead of accepting the first match. Rejects same-encoding symlinks pointing at wrong dirs. Surfaces the "encoding is genuinely ambiguous" case (`/a-b` vs `/a/b`) explicitly instead of silently picking one. Returns a structured `Located {dir, ambiguousWith, exhausted}`.
- **Why we want it:** we don't currently have this correctness. Resume-by-folder is a real path; ambiguity gets silently resolved wrongly today.
- **Effort:** ~2 hours. Their tests port cleanly.

#### A3. Session-catalogue design doc (`docs/session-catalogue-layer.md`)
- **Source:** `1fc8241` and preceding
- **File:** informational only.
- **What it does:** captures the "fleet-wide session catalogue" mental model — session-provenance ownership, edit intents as protocol, Host identity via `scutil LocalHostName`, why timestamp-based conflict resolution is wrong for this shape.
- **Why we want it:** even if we don't implement the merged view, the doc explains a design that could inform how we think about our own multi-machine story later.
- **Effort:** 5 min to copy the doc.

### Rank B — take the concept, reshape onto our identity model

#### B1. `lineage` view — a role's session bodies in succession
- **Source:** `6a91202 feat(catalogue): lineage — a role's bodies in succession, transcripts searchable`
- **Files:** `src/catalogue/lineage.ts`, `src/parse.ts` humanText extractor
- **What it does:** `ccs lineage <role>` lists sessions grouped as successive "bodies" of the same role (first-activity ascending, unindexed last, live ones marked ●). `--search "<q>"` streams transcript files with a raw-line prefilter so JSON.parse only runs on lines that might match — handles 66MB transcripts. Case-insensitive literal match.
- **Why we want it:** exactly the query we'd want for "what did the pr-agent worker for #12143 say across its lifetime, including prior session bodies?" Under ADR-0089 the natural axis is `identity_key`, not `role`, but the query is the same shape.
- **Reshape needed:** rename to `ccs identity lineage <identity_key>` (or `ccs sessions --identity <k>`). Group sessions by attached identity_key rather than by role. Use our catalogue join, their transcript-streaming logic.
- **Effort:** ~half day. Their raw-line-prefilter trick is the load-bearing bit — copy that as-is.

#### B2. Skill category in `SKILL.md` frontmatter (canonical) with DB fallback
- **Source:** `30dd852 feat(skills): category lives in SKILL.md frontmatter — canonical, db is fallback` + `c9a6ad4 feat(skills): category writes target SKILL.md frontmatter; db rows pruned on rescan`
- **Files:** `src/skills/scan.ts`, `src/skills/db.ts`, `src/skills/command.ts`, `src/skills/category-write.ts`, `src/tui/skills/SkillsPanel.tsx`
- **What it does:** `category:` in the SKILL.md YAML frontmatter is canonical; skills-db categories table is only fallback for skills whose files we don't own (plugins, third-party ecosystems). Category writes edit the file for editable skills, fall back to DB for foreign. Rescans prune DB rows shadowed by frontmatter.
- **Why we want it:** categories currently live only in the local DB, so they don't travel with the vault and get wiped on DB rebuild. Frontmatter fixes both.
- **Reshape needed:** minimal — our skills module has the same rough shape.
- **Effort:** ~2-3 hours.

#### B3. Grok + IDE ecosystem skill discovery
- **Source:** `48caabe feat(skills): grok + ide ecosystems — grok CLI caches and Copilot assets are not project skills`
- **Files:** `src/skills/scan.ts`
- **What it does:** teaches the skills scanner about `~/.grok/marketplace-cache`, `~/.grok/skills`, and VS Code Copilot prompt assets — classifies them into `marketplace / grok / ide` categories instead of misfiling them as project skills.
- **Why we want it:** if you also use grok or Copilot, their assets stop polluting your project skills list. Small QOL.
- **Reshape needed:** none, additive to `scan.ts`.
- **Effort:** ~1 hour.

### Rank C — take the *ideas*, don't take the code

#### C1. "Merged View" concept — multi-Host session catalogue
- **Source:** `1fc8241 feat(catalogue): the Merged View — one fleet-wide catalogue, Host-owned rows, edit intents`
- **What it does:** `ccs merge` unions each Host's catalogue + Index snapshot into `merge.db`; `ccs merge --pull` fetches it from a peer; `ccs ls --fleet` reads it. Every row is owned by whichever Host holds its transcript (`scutil LocalHostName` identity). Cross-Host writes refuse; you use `ccs intent <id> <op> <value>` to queue an edit that the owning Host applies via `ccs apply-intents`.
- **Why not just port:** their implementation assumes their v5 schema (`role`, `substrate`, `identity` as CLAUDE_IDENTITY env var). Our schema is very different (identity_key structured, identity tables per-role). A port would be a full rewrite.
- **Take the ideas:**
  - **Ownership by transcript-holder, not by timestamp.** Timestamps race; the machine that ran the session is authoritative.
  - **Edit intents as a queue.** Never write another Host's row directly; queue an intent, let them apply. Protocol laws around dead-lettering malformed intents, boundary-validating envelope bodies, selective consumption (only your own intents).
  - **`scutil LocalHostName` as identity, not `hostname` (which is DHCP-name and worthless).** Their PR body called this out as a real footgun.
- **Effort if we implement:** week+, and we'd want to do it *after* our identity model is stable. Not yet.

#### C2. "Role edge / substrate / identity" schema (v5)
- **Source:** `061b351 feat(catalogue): v5 — role edge, substrate, identity (the kernel's ontology)`
- **What it does:** adds three columns to `sessions`:
  - `role` — free-string, references a role definition in the vault by name.
  - `substrate` — agent runtime (`claude-code` normalized to NULL, `grok`, `codex`).
  - `identity` — the `CLAUDE_IDENTITY` env var the launcher exported (Issue 64's registry).
- **Why not just port:** we have `identity_key` doing the durable-identity job in a much richer way (per-work-unit, structured, with per-role attribute tables). Their `identity` column is basically a launcher-provenance breadcrumb — much thinner.
- **Take the ideas:**
  - **`substrate` field is genuinely useful for cross-tool.** If we ever host grok or codex sessions in ccs, we'd want to distinguish them. Cheap to add later.
  - **`CLAUDE_IDENTITY` env-var registry (Issue 64).** Even a "self-stamp from env, hook-friendly" `ccs identity` command is nice for scripts that want to attribute their session cleanly.
- **Effort if we implement:** small, but wait for a real need.

#### C3. Fleet crash-log resilience patterns
- **Source:** `b694b74 fix(merge): never copy the -shm — a stale one silently drops WAL rows`
- **What it does:** documents that snapshotting a SQLite DB by copying `.db + .wal + .shm` is subtly wrong — a stale `.shm` makes SQLite skip un-checkpointed WAL frames on the reader side. Copy `.db + .wal` only; SQLite rebuilds `.shm` from the WAL header.
- **Why we want the knowledge:** we do live-catalogue reads for scratch-copies in the overnight harden loop. Our helper *may* already be doing the right thing; worth auditing.
- **Effort:** 15 min to grep our scratch-copy code, 30 min if we find a bug.

### Rank D — probably skip

#### D1. `role groups` TUI view (`groupsView.ts` overhaul)
- **Source:** `b72e01e feat(tui): role groups — the constellation's durable grouping nodes, first`
- **What it does:** TUI gains ◈ role sections ahead of constellations. Membership follows the nearest role-carrying ancestor. Role bodies order by subtree recency, not root age. Preview shows role/substrate/identity.
- **Why skip:** our TUI already has `clusterView` and `epicView` which do the same job on our schema. This one is designed for their schema (role/substrate/identity as free-string columns on sessions). Reimplementing on our shape is significant TUI work for a view we already have.

## Execution plan

Order matters — do smallest / most contained first, so early wins land before the big-effort items.

| Order | Item | Effort | Blocker? |
|---|---|---|---|
| 1 | Push `preservation/fleet-view-2026-07-18` from origin (safety net) | 2 min | none |
| 2 | A3 — session-catalogue design doc | 5 min | none |
| 3 | A1 — durable crash logging | 30 min | none |
| 4 | C3 — audit our scratch-copy for -shm bug | 30 min | none |
| 5 | B3 — grok + IDE ecosystem skill discovery | 1 hr | none |
| 6 | A2 — round-trip resume-cwd guard | 2 hr | ours has diverged from theirs; port their tests |
| 7 | B2 — skill category in frontmatter | 2-3 hr | our skills module shape check first |
| 8 | B1 — lineage as `ccs identity lineage` | half day | reshape from `role` to `identity_key` |
| — | Force-push local master over origin | 5 min | after 1-7 land |
| — | C1 (Merged View) | week+ | future — needs stable identity model first |
| — | C2 (substrate/CLAUDE_IDENTITY) | small | when we actually host non-Claude agents |

Total effort for ranks A + B: **~1.5-2 days**. Rank C items get filed as
follow-ups; rank D is dropped.

## Cutover

Once ranks A + B are landed on local master:

1. Confirm `bun test` green, typecheck clean, `ccs --help` unchanged.
2. Force-push:
   ```
   git push origin overnight/harden-and-dogfood
   git push origin master:preservation/fleet-view-2026-07-18   # from origin's current tip
   # Then, deliberately, after preservation is verified on GitHub:
   git push --force-with-lease origin master
   ```
3. Personal computer pulls: `git fetch --all && git reset --hard origin/master`. Migrations auto-run on first `ccs` invocation.

## What we're deliberately not taking

- **The whole ADR-0001 through ADR-0089 deletion.** Origin deleted all of them; we keep ours. They're load-bearing decision history for the production pr-watch fleet.
- **The `state/` module deletion.** Origin deleted `src/state/store.ts`, `work-units.ts`, `suppress.ts`, `state-command.ts`. All alive on our side.
- **The `clusterView` and `epicView` TUI deletion.** These render our board and epic queries; keep them.
- **The `catalogue/identity-schema` and per-role identity tables (ADR-0089 step 3).** Origin's schema has no equivalent.
- **The `inbox/` module deletion.** Origin removed inboxes entirely; we depend on them for the signal bus.

## Follow-ups (file separately)

- **Cross-machine session merge (C1).** File as an ADR when we're ready.
- **`substrate` column (C2).** File when we onboard a non-Claude agent.
- **Fleet Merge is a great CI/local-dev pattern.** Even without implementing the full fleet, the pattern of "snapshot-copy first, open the copy" is worth adopting for any tooling that reads catalogue live.
