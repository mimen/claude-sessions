# ccs system units — defined in dependency order

Every unit of the system, ordered so each is built from units defined **above** it plus terms from the
[glossary](GLOSSARY.md). Read top-to-bottom: the earliest units are the smallest primitives; the last are
the big flows, expressed purely as compositions. Bold terms are [glossary](GLOSSARY.md) entries; `Uxx`
references are earlier units.

Each unit lists: **Definition** (in shared vocabulary only) · **Inputs** · **Outputs** · **Composes**
(which earlier units it builds on) · **Code** · **Status** note where relevant (ties to the burn-down matrix
U1–U32; note IDs here are re-sequenced by dependency, with the matrix ID in brackets).

Ground truth: extracted from `src/` on 2026-07-11. `⚠` marks a known issue.

---

## TIER 0 — pure primitives (no dependencies beyond the glossary)

### S1 · path-encoding & storage-folder  ·  [matrix: part of U7]
- **Definition:** the pure mapping between a **session**'s cwd and its **storage folder** — encode a path
  by replacing non-alphanumerics with `-` (mirroring Claude Code), and recover the **launch dir** by
  finding the real directory whose encoded realpath matches a given storage folder.
- **Inputs:** a cwd string (encode) / a transcript file path (locate).
- **Outputs:** an encoded folder name / the resolved **launch dir** (or null if not found).
- **Composes:** nothing (leaf).
- **Code:** `resume/locate.ts` — `encodePath`, `storageFolderOf`, `decodeStorageFolder`, `locateLaunchDir`.

### S2 · work-unit key  ·  [U4, P0]
- **Definition:** derive the **work-unit** string for a **session** — `pr:repo#number` (PR wins) else
  `gus:W-id` else `sid:sessionId`.
- **Inputs:** the PR facts + gusWork + sessionId of a **CatalogueRow** (or raw spawn facts).
- **Outputs:** a canonical work-unit string (or null when there's no PR/gus and sid isn't wanted).
- **Composes:** nothing (leaf) — but it's the join key many later units rely on.
- **Code:** `spawn-contract.ts:23` (`spawnWorkUnit`, `rowWorkUnit`).
- **⚠ Status:** implemented **6×**, 2 copies drifted to a non-joining `repo-number` form
  (`resolve-levels.ts:48`, `start-actions.ts:36`). Consolidate to one canonical primitive here.

### S3 · shell-quote & resume-command builder  ·  [part of U7]
- **Definition:** pure construction of the exact `claude` invocation — POSIX-quote an argument, and build
  `claude --resume <resumeId> [resume_command]` with its **launch dir**.
- **Inputs:** a **SessionRow** + `{fork, cwd, resumeCommand}`.
- **Outputs:** a `ResumeCommand {argv, cwd, shell}`.
- **Composes:** S1 (to resolve the cwd/launch dir).
- **Code:** `resume/command.ts` — `shellQuote`, `buildResumeCommand`, `resolveResumeCwd`.

### S4 · state doc + mergeFields  ·  [U15, P2]
- **Definition:** the durable JSON store primitive — write a **state doc** atomically (temp+rename) inside a
  `{schemaVersion, updatedAt, source, data}` envelope; read one back (missing = null, corrupt =
  quarantined); **mergeFields** does a single-writer-per-field read-merge-write.
- **Inputs:** a path, a data object (or field subset), write opts `{now, source}`.
- **Outputs:** void (write) / the envelope or null (read).
- **Composes:** nothing (leaf).
- **Code:** `state/store.ts` — `writeDoc`, `readDoc`, `mergeFields`.
- **⚠ Status:** read-modify-write has no lock (D3); safe only under the single-writer-per-field convention.

### S5 · merge combinators  ·  [part of U10]
- **Definition:** the five pure **merge strategy** functions that fold ordered **hook** layers into one
  effective config: `sections`, `set-union`, `ordered-actions`, `most-specific`, `union-deny-wins`.
- **Inputs:** an ordered array of per-**level** layers of the strategy's shape.
- **Outputs:** the merged config (shape per strategy).
- **Composes:** nothing (leaf).
- **Code:** `hooks/merge.ts`.

---

## TIER 1 — records & parsing (build on Tier 0)

### S6 · CatalogueRow + catalogue store  ·  [U2, P0]
- **Definition:** the durable **catalogue** — one **CatalogueRow** per **session**, with typed
  QUERY/MUTATION accessors and a versioned **migration** chain. Every metadata axis (**role**, **cluster**/
  cluster, **key**, **grouping**/epicId, gusWork, PR facts, **stage**, **activity**, **statusLine (field)**,
  **miladReview**, **buildComplete**, lifecycle) lives here.
- **Inputs:** a DB handle + sessionId; mutations also take a value + `now` timestamp.
- **Outputs:** a **CatalogueRow** / lists of sessionIds (`sessionsForRole`, `sessionsForSystem`,
  `sessionsForPr`, …) / void (mutations).
- **Composes:** S2 (work-unit appears via `rowWorkUnit`).
- **Code:** `catalogue/db.ts` (CatalogueRow `:15-79`; migrations v1–v19 `:99-321`).
- **⚠ Status:** migrations v1→v19 have zero tests; v16–v19 were hand-patched on the live DB; v14/v15 DROP
  tables. This is the single most under-tested high-blast-radius unit.

### S7 · SessionRow + index/reindex  ·  [U1, P1]
- **Definition:** the ephemeral **index** — parse each transcript file into a **SessionRow** (cwd, project,
  timestamps, **resumeId**, cost/tokens, user-turns, tick cadence, resolved **title**) and incrementally
  reindex (only re-parse files whose mtime/size changed).
- **Inputs:** transcript files + host name; a DB handle.
- **Outputs:** upserted **SessionRow**s; `ReindexStats {scanned, parsed, skipped, removed}`.
- **Composes:** nothing structural (reads files); shares the **sessionId**/**resumeId** vocabulary with S6.
- **Code:** `index/index.ts`, `index/schema.ts`.

### S8 · lineage / predecessors  ·  [part of U3]
- **Definition:** compute a **session**'s **lineage** — the other **embodiments** sharing its
  **identity-key**, oldest→newest — by joining **catalogue** rows (S6) with **index** transcript timestamps
  (S7).
- **Inputs:** the catalogue rows map + the index paths map + a sessionId.
- **Outputs:** an ordered `Embodiment[]`.
- **Composes:** S2 (identity-key uses work-unit), S6, S7.
- **Code:** `catalogue/lineage.ts`.
- **⚠ Status:** the tie-break returns 0 when both timestamps are null → nondeterministic order (D2, P0,
  one-line fix).

---

## TIER 2 — cmux embodiment (build on records)

### S9 · cmux tree + hook-store readers  ·  [part of U5/U21]
- **Definition:** the two side-effecting reads of **cmux** state — run `cmux tree` (the **tree**) and read
  the **hook store** file — each returning its data plus an `ok` **readable** flag.
- **Inputs:** none (shells out / reads a fixed path).
- **Outputs:** `{tree, ok}` and `{store, ok}`.
- **Composes:** nothing (leaf I/O).
- **Code:** `cmux/live.ts` — `readTree`, `readHookStore`.
- **⚠ Status:** no cmux **version** guard; **hook store** path hardcoded (U21, P0).

### S10 · the bridge (liveness)  ·  [U5, P1]
- **Definition:** build the **bridge** by parsing the **tree** into **surface** locations and intersecting
  the **hook store** bindings with it, so only a **surfaceId** present in BOTH counts as live; expose
  **liveness** queries (`isOpen`, `locateSession`, `primarySurface`) and the **readable** flag.
- **Inputs:** a **tree** + a **hook store** (+ readable flag) — from S9, or injected for tests.
- **Outputs:** a `Bridge` (surface list, session↔surface maps, `readable`).
- **Composes:** S9.
- **Code:** `cmux/bridge.ts` (`buildBridge`), `cmux/liveness.ts`, `cmux/live.ts` (`liveBridge`).
- **Status:** the core is well-tested (fixtures); the live I/O wrapper (S9→S10) is not.

### S11 · spawnCmux primitive  ·  [U6, P0]
- **Definition:** **spawnCmux** — launch a `claude` argv into a fresh detached **workspace** as a plain
  command (so cmux's shim registers it in the **hook store**), returning the new **workspace** ref.
- **Inputs:** `{argv, cwd, name, focus?, cmuxBin?}`.
- **Outputs:** the workspace ref string, or null on failure.
- **Composes:** S3 (argv/quoting).
- **Code:** `resume/spawn-cmux.ts`.
- **⚠ Status:** zero tests; `Bun.spawnSync` has no timeout; ref parsed by bare regex (P0).

---

## TIER 3 — hook resolution & identity runtime

### S12 · responsibility → identityDir + inbox  ·  [U14, P2]
- **Definition:** map a **responsibility** to its **identity** runtime dir, and operate its **inbox** —
  write a **message** atomically, **drain** move-on-drain, list pending.
- **Inputs:** a runtime root + a **responsibility**; for write: sender/body/stamp.
- **Outputs:** the identity dir path; message paths / drained `InboxMessage[]`.
- **Composes:** S2 (work-unit is part of the responsibility key).
- **Code:** `inbox/identity-path.ts`, `inbox/inbox.ts`.

### S13 · role-def loading  ·  [part of U8/U11]
- **Definition:** read a **role-def** from files — parse **role.toml** for **kind**/**resume_command** and
  derive homeDir/**skills**/**commands**/**hooks** from the role directory (files-as-truth, no cache).
- **Inputs:** a role directory + role name + optional cluster.
- **Outputs:** a `RoleDef` (or null); fail-open on malformed TOML.
- **Composes:** nothing structural.
- **Code:** `roles/role-files.ts`.

### S14 · hook level resolution  ·  [part of U10]
- **Definition:** the pure **resolution** from a **CatalogueRow** to the ordered **level** list
  (`user→cluster→role→epic→work-unit→identity`) and each level's config dir — never reads cwd/env.
- **Inputs:** a **CatalogueRow** + a ctx `{configRoot, runtimeRoot, roleHomeDir}`.
- **Outputs:** an ordered `ResolvedLevel[]`.
- **Composes:** S2 (work-unit level), S12 (identity dir), S13 (roleHomeDir).
- **Code:** `hooks/resolve-levels.ts`.

### S15 · effective hook config  ·  [U10, P1]
- **Definition:** read each **level**'s `.ccs-hooks/<type>` file and fold them with the type's **merge
  strategy** into one effective config, tracking a `degraded` flag when a layer errors.
- **Inputs:** a **CatalogueRow** + a **hook type** name + ctx.
- **Outputs:** `EffectiveConfig {effective, layers, degraded, errors}`.
- **Composes:** S14 (levels), S5 (merge combinators).
- **Code:** `hooks/resolve-config.ts`.

---

## TIER 4 — rendering & the spawn/resume flows

### S16 · tab & statusline rendering  ·  [U12/U13]
- **Definition:** pure render of a **CatalogueRow** into a **tab** (`{title, description, color,
  statusPill}`) and a **statusline** string — **statusLine (field)** wins the description slot; the **pill**
  comes from **stage × activity** (or legacy **phase**); staleness-aware.
- **Inputs:** a **CatalogueRow** (+ **kind**, + optional **grouping** display ctx).
- **Outputs:** `TabRenderOps` / a statusline string.
- **Composes:** S6 (the row).
- **Code:** `catalogue/render-tab.ts`, `catalogue/render-statusline.ts`.

### S17 · sync-tabs  ·  [U12, P1]
- **Definition:** push rendered **tab** ops to **cmux** by **surfaceId** — locate the session's **surface**
  via the **bridge**, apply the **cmux-paint** override, and rename/paint the **workspace**; never paint a
  **retired** tab.
- **Inputs:** a sessionId (or `--all`) + optional workspace-ref override.
- **Outputs:** boolean pushed / exit code.
- **Composes:** S10 (bridge), S15 (cmux-paint config), S16 (render ops).
- **Code:** `catalogue/sync-tabs.ts`.

### S18 · selector resolution  ·  [U17, P2]
- **Definition:** resolve a **selector** token to **sessionId**s — infer its axis (id / `#pr` / `W-id` /
  **grouping** / **role** / **cluster**) or take an explicit pin, deterministically ordered.
- **Inputs:** catalogue + index handles, a token, `{pin?, cluster?}`.
- **Outputs:** `SelectorResult {kind, label, sessionIds}` or null.
- **Composes:** S6 (the `sessionsFor*` queries).
- **Code:** `resume/selector.ts`.

### S19 · spawn contract  ·  [U9, P0]
- **Definition:** the born-correct gate — refuse a worker **spawn** unless it passes the **one-embodiment
  rule** (its **work-unit** has no live **embodiment**) and the **correct-worktree** check; **core** roles
  pass through.
- **Inputs:** spawn facts, the set of live **work-units**, the cwd's worktree state.
- **Outputs:** an error string, or null (OK to spawn).
- **Composes:** S2 (work-unit), S10 (live work-units come from the bridge's open sessions).
- **Code:** `catalogue/spawn-contract.ts`.
- **⚠ Status:** TOCTOU — the live-work-units read and the actual spawn aren't atomic (D1, P0).

### S20 · resume one session  ·  [U7, P1]
- **Definition:** revive one closed **session** — check **liveness** via the **bridge** (skip if
  **embodied**), **fail closed** if not **readable**, else build the **ResumeCommand** and **spawnCmux**,
  then eager-paint the **tab**.
- **Inputs:** index + catalogue handles, a sessionId, `{dryRun?, bridge?, focus?}`.
- **Outputs:** `ResumeSessionResult` (`resumed` / `already-open` / `not-indexed` / `spawn-failed` /
  `liveness-unreadable`).
- **Composes:** S10 (bridge), S3 (command), S1 (launch dir), S11 (spawnCmux), S17 (eager paint).
- **Code:** `resume/resume-session.ts`.

### S21 · spawn a new session  ·  [part of U9 + new-session]
- **Definition:** mint a **sessionId**, resolve the **spawn-location** (**hook**), run the **spawn
  contract**, write **catalogue** metadata (forward reference), then launch via **spawnCmux** (detached
  default) — or inline / print-id.
- **Inputs:** parsed `NewSessionOpts` (role, cluster, kind, work-unit facts, cwd, prompt, …).
- **Outputs:** exit code; a live **session** bound to a **surface**.
- **Composes:** S19 (contract), S15 (spawn-location config), S6 (write metadata), S11 (spawnCmux), S13
  (role-def validation).
- **Code:** `catalogue/new-session.ts`.

### S22 · resume a cluster (supersede-dedup)  ·  [U8, P1]
- **Definition:** resume every not-open **session** of a **cluster** — **fail closed** if **liveness** is
  unreadable, classify each member (**retired** / **superseded** / resume-candidate) under the
  **one-embodiment rule** via **supersede-dedup**, then delegate each survivor to S20.
- **Inputs:** index + catalogue handles, a cluster (or a set of sessionIds), `{dryRun?, bridge?}`.
- **Outputs:** `ClusterResumeSummary {resumed, alreadyOpen, retired, superseded, notIndexed, failed,
  abortedUnreadable, perSession[]}`.
- **Composes:** S10 (one shared bridge snapshot), S6 (`sessionsForSystem`), S20 (per-session), S18 (when
  driven by a selector).
- **Code:** `resume/resume-cluster.ts`.

---

## TIER 5 — hooks firing & the pr-watch cluster

### S23 · hook firing (SessionStart / Stop)  ·  [U11, P0]
- **Definition:** at a Claude lifecycle moment, resolve the **effective hook config** (S15) and act:
  SessionStart injects **claude-md** context and runs **start actions** (**arm**, **drain-inbox**); Stop
  runs **meta-update** refresh + the phase rubric and re-paints the **tab**.
- **Inputs:** the firing session's row + source (`startup`/`resume`/…).
- **Outputs:** additionalContext text; side effects (drained **inbox**, painted **tab**).
- **Composes:** S15 (config), S12 (inbox drain), S16/S17 (paint), S6 (meta touch).
- **Code:** `hooks/register-command.ts`, `hooks/start-actions.ts`, `hooks/worker-stop-command.ts`.
- **⚠ Status:** SessionStart & Stop are double-registered in `settings.json` → every hook fires 2× (P0).

### S24 · phase model (stage × activity)  ·  [U28, P0]
- **Definition:** a PR worker's status = a monotonic **stage** (`building→milad-review→in-review→approved→
  merged`, engine-latched via **buildComplete**) crossed with a transient **activity** (`working`/
  `needs-you`/`fixing`); surfaced as the **pill** (S16) and advanced by `ccs ready` / `ccs approve` /
  `ccs activity`.
- **Inputs:** worker self-reports (**activity**), engine sensing (**stage**, `fixing`), Milad (**ready**/
  **approve**).
- **Outputs:** **stage**/**activity**/**miladReview** on the **CatalogueRow**.
- **Composes:** S6 (the columns), S16 (render).
- **⚠ Status:** built, never verified live on a running worker (P0 flow proof).

### S25 · the roles (control / concierge / slack-scout / eval / pr-agent / designer)  ·  [U22–U27]
- **Definition:** the six **role**s of the **pr-watch** **cluster**, each a **loop** or **session** whose
  behavior is its **skills**/**commands** and whose runtime is its **identity** (**inbox** + **state**).
  **control** senses and drives; **concierge** talks to Milad; **slack-scout** senses Slack; **eval**
  grades; **pr-agent** owns one **work-unit**; **designer** designs.
- **Inputs:** each role's **role-def** (S13) + **identity** runtime (S12) + resolved **hooks** (S15).
- **Outputs:** their actions (sensing, routing, PR work) + reports.
- **Composes:** S12, S13, S15, S23; workers run through S19/S21; the loop through S22.
- **⚠ Status:** all run daily but none verified end-to-end live this arc (P1).

### S26 · sense + board/gate/pending  ·  [U31/U32, P1/P2]
- **Definition:** the engine **sense** step reads git/GitHub/Slack and writes **cluster state** (**board**/
  **gate**/**pending**) via **mergeFields**; the **control** **tick** `!`-injects those docs. State is
  sensor-driven, never session-remembered.
- **Inputs:** git/GitHub/Slack facts; the cluster.
- **Outputs:** updated **cluster state** docs; PR facts stamped onto **CatalogueRow**s.
- **Composes:** S4 (state docs), S6 (stamp PR facts).
- **Code:** `engine/scripts/catalogue_sync.py`, `sense.sh`.

### S27 · the gate + lifecycle marks  ·  [U29/U30, P1]
- **Definition:** the **gate** invariant — a PR clears internal review AND **miladReview** before any public
  review — enforced across the loop; and **mark**, the control-owned **completed**/**archived** lifecycle
  transition (workers never self-mark; **retired** sessions are never resumed).
- **Inputs:** **miladReview** + sensed review facts (gate); sensed merge/deploy facts (mark).
- **Outputs:** gate pass/hold; lifecycle bits on the **CatalogueRow**.
- **Composes:** S6 (lifecycle + miladReview), S24 (stage), S26 (sensed facts).

---

## The big flows, as compositions (reading key)
- **`ccs new-session`** = S21 = S19(contract) + S13(role-def) + S15(spawn-location) + S6(write) + S11(spawn).
- **`ccs resume-session`** = S20 = S10(liveness) + S3(command) + S1(launch dir) + S11(spawn) + S17(paint).
- **`ccs resume-cluster`** = S22 = S10 + S6 + S20 (+ S18 if by selector).
- **SessionStart** = S23 = S15 + S12(drain) + S16/S17(paint).
- **the pr-watch loop** = S25 roles driving S26(sense) → S24(phase) → S27(gate/mark), workers born via S21,
  revived via S22.

Naming-debt reconciliation (from the glossary) is cross-cutting and touches S6 (cluster/system, epic/
grouping, key/event, role/skill, phase columns) + S2 (work-unit drift) — fixing it makes every unit above
readable in one vocabulary.
