# Resume lookup is cwd + sibling-worktree scoped; the real failure mode is a stranded storage folder

**Status:** accepted (2026-07-21)
**Scope:** ccs resume path (`resolveResumeCwd`, `locate.ts`, `spawnCmux`) + operator recovery
**Companion scoping doc:** `docs/worktree-aware-resume.html` (the live investigation; this ADR is the durable record)

Closes a two-hour investigation that started as "ccs resumed from the wrong cwd" and ended
somewhere else entirely. Three theories were raised and empirically killed in turn; the real
failure class was found by sweeping all 1,954 indexed sessions. Extends ADR-0021 Issue 2
(resume cwd drift) with a confirmed mechanism and two operator recovery recipes. Decided with
Milad 2026-07-21.

## Decision

- **ccs computes the resume launch dir correctly, and cmux honours it.** Verified by 9 live
  spawns through an instrumenting cmux shim: `requestedCwd == actualCwd` in every case,
  including spawns that correctly landed inside a live git worktree. cmux does NOT ignore
  `--cwd`. No code change to the spawn path.
- **ccs does not implement `--worktree` and must never emit it.** The harness `--worktree` flag
  cannot affect whether a session is *found* (mechanism below). The
  "Resume this session with: `claude --worktree …`" line is cosmetic exit-time output describing
  the *process*, not the session, and it prints on failed exits too. Never treat it as a spec —
  this reinforces the standing rule in `src/resume/command.ts:15` ("never from a printed hint").
- **The real, large failure class is a stranded storage folder**: a session whose recorded cwd
  no longer maps to its transcript's storage folder, because the directory was **deleted** or
  **replaced by a symlink**. A sweep of all 1,954 non-subagent sessions found 688 in this state,
  collapsing to 10 directories / 2 causes (593 symlink, 95 deleted — see below).
- **SHIPPED (commit 8098174, approach A): `resolveResumeCwd` recreates a deleted anchor.** When
  nothing on disk maps to the storage folder and the recorded cwd is simply GONE, ccs rebuilds
  that exact directory, verifies it restores the mapping, and resumes from it — idempotent,
  non-destructive, self-cleaning. This future-proofs the *recurring* case (worktree-per-issue
  removal, cleaned scratch dirs). It deliberately does NOT cover a cwd that still exists but has
  become a **symlink** (realpath now differs) — that needs a transcript move, out of the resume
  hot path, and is left as documented operator recovery.

## The mechanism (verified in Claude Code 2.1.217)

Resume-by-explicit-id resolves as `n = await C8e(e) ?? await Ng_(e)`:

- **`C8e(id)`** loads `<projectDirFor(cwd)>/<id>.jsonl`, where the project dir is
  `join(projectsRoot, encode(realpath(cwd)))` — the same encoding mirrored in
  `src/resume/locate.ts:25`. Note **`realpath`**: the harness resolves symlinks before encoding.
- **`Ng_(id)`** is the fallback (telemetry `tengu_resume_worktree_fallback`): it runs
  `git worktree list` in the cwd and searches the project folders of that repo's **sibling
  worktrees only** — never a parent directory. Empty if cwd is not a git repo.

Nothing in either path consults a session→worktree binding, `~/.claude.json`, or
`activeWorktreeSession`. So the launch dir is *necessary and sufficient*: any directory whose
`encode(realpath(dir))` equals the storage folder resumes on the first lookup, and no directory
that fails that test can be rescued by a flag. `locate.ts` derives exactly such a directory, so
ccs is strictly stronger than the harness's own repo-local fallback.

## The stranded-storage-folder class (the actual bug)

A sweep of all 1,954 non-subagent indexed sessions: **1,266 resolve to a launch dir that
resumes; 688 do not.** The 688 collapse to **10 directories, two causes**:

| Count | Cause | Example |
| --- | --- | --- |
| 593 | recorded cwd is now a **symlink**, so `realpath` resolves elsewhere and the physical folder ≠ the transcript's logical folder | `~/Programming/Repos/imsg` → `convex-db/.worktrees/main/apps/imsg` (symlinked 2026-07-20); `imsg/client`; `t3code-spike-sessions` |
| 95 | recorded dir was **deleted** | dead `.claude/worktrees/*` worktrees, ephemeral `/private/tmp/**/scratchpad` |

Live-confirmed for the symlink case: `claude --resume <imsg-id>` from `~/Programming/Repos/imsg`
(the symlink) → **"No conversation found."** Because the harness encodes `realpath(cwd)`, once a
directory becomes a symlink every transcript filed under its old logical path is stranded — no
real directory has the matching realpath any more.

This is external state (an in-progress convex-db migration, deleted worktrees), not an ccs
computation bug. But ccs currently masks it behind a soft note and a doomed spawn.

## Operator recovery (both verified)

- **Deleted dir** — recreate the folder the transcript is filed under, then resume from it:
  ```sh
  mkdir -p "<recorded-cwd>"          # e.g. the removed worktree path
  cd "<recorded-cwd>" && claude --resume <id>
  ```
  Verified: after `mkdir`, `encode(realpath(dir))` again equals the storage folder and resume
  succeeds. (Recovered `bd0948c0` this way.)
- **Symlinked dir** — the transcript is under the *logical* folder but the harness looks under
  the *physical* one. Non-destructive fix: move the stranded transcripts from
  `~/.claude/projects/<logical-folder>/` to `~/.claude/projects/<physical-folder>/`, then resume
  from the (symlinked) cwd as normal. Do **not** replace the symlink with a real dir — it exists
  for the monorepo layout.

## Why the earlier theories were wrong (kept — the process is the lesson)

| Theory | Killed by |
| --- | --- |
| ccs silently returns a wrong resume command; needs `--worktree`. | The early-return guard (`command.ts:65`) tests the *same predicate* the harness uses, so it can never return a non-matching dir. And `--worktree` is cosmetic. |
| A stale `~/.claude.json` binding drives the failure. | The exit hint reads process-local worktree state (`Gbc()`), never that file. |
| cmux ignores ccs's `--cwd` and reuses a persisted worktree workspace. | 9 live instrumented spawns: `requestedCwd == actualCwd` every time (0 mismatches). |

Two rounds of confident reasoning preceded reading the shipped binary and instrumenting the
real spawn. The lesson matches `command.ts:15` and ADR-0021: trust the transcript and a live
probe, not an error string.

## Testing caveat (learned the hard way)

`claude --resume` invoked from inside a running Claude Code session (e.g. an agent's Bash tool)
is CONTAMINATED: it inherits `CLAUDECODE`, `CLAUDE_CODE_*`, and the cmux `claude` shim on PATH,
which redirect the child's project lookup to home — producing false "No conversation found"
results. Validate resume behaviour in a clean shell or strip the vars
(`env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID …`). Under a clean env,
the shipped fix resumes a genuinely-stranded session end-to-end (verified: recreate anchor →
`claude --resume` → reply), and the symlink strand genuinely still fails (transcript folder ≠
realpath folder) — so both conclusions hold once the harness contamination is removed.

## Consequences

- `resolveResumeCwd` now recreates a deleted anchor (approach A, commit 8098174; test
  `src/resume/recreate-anchor.test.ts`). `locate.ts`, `spawnCmux`, and the schema are unchanged;
  `--worktree` stays unimplemented.
- `locate.ts`'s header should note the `Ng_` fallback and the realpath rule (the necessary-and-
  sufficient framing). (Re-apply after the current checkout churn settles — an earlier attempt
  was reverted by concurrent development on this tree.)
- **Open follow-up:** the **symlink** strand (593 sessions, e.g. the `imsg` migration) is not
  auto-recovered — approach A only rebuilds *deleted* anchors. A one-off migrate command (move
  the stranded transcripts from the logical folder to the physical folder) would recover them;
  it belongs outside the resume hot path. Until then the fallbacks still emit the soft "could not
  confirm storage dir" note for this class; turning that into a hard, recipe-bearing failure is a
  small detection/UX nicety, not a correctness fix.
- ADR-0021's immunity claim is upheld and now has a mechanism: ccs derives the launch dir from
  the storage folder, so it is correct whenever a matching real directory exists — and honestly
  cannot resume when none does (deleted/symlinked), which is a data-stranding problem, not a
  cwd-computation one.
