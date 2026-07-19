# Worker allowlist grants the scripts DIRECTORY, not each file (forward-compatible)

Resolves the "allowlist frozen at spawn" fragility (O4 residue). Decided with Milad
2026-07-09.

## The fragility

`spawn-agent.sh grant_worktree_perms` writes each worker's Bash allowlist ONCE at
spawn, enumerating the mandatory pr-watch scripts by exact path:
`Bash(python3 .../scripts/inbox.py:*)`, `changelog.py`, `validate_result.py`,
`pr_body_lint.py`. Consequence: add a 5th script a worker must run every task, and
every ALREADY-LIVE worker stalls on it — its frozen allowlist has no rule for the new
script, and under `--permission-mode acceptEdits` a Bash call with no matching allow
rule prompts (and a headless worker has no one to answer). This already bit once (O4);
it recurs on every new mandatory script.

## Decision

Grant the scripts DIRECTORY with a single glob, not each file:

    Bash(python3 /Users/mimen/Documents/pr-watch-2/scripts/*.py:*)

- Covers any current-OR-future pr-watch script, so a newly-added mandatory script
  never stalls a live worker.
- Scoped to OUR scripts directory only. This is NOT a blanket `Bash(*)` — a worker
  still cannot run arbitrary commands; only `python3` against a file in the pr-watch
  scripts dir. The blast radius is exactly "the scripts we ship," which is the set a
  worker is supposed to be able to run.

## Write/Edit scope stays broad (deliberately)

The companion grants stay as they are: `Write/Edit(<state-dir>/**)` and
`Write/Edit(<worktree>/**)`. A worker legitimately needs these — its result/judgment
files, its inbox drain, PR-body edits. The blast radius here is bounded by the
CONSTITUTION + push≠post rules (what the worker is allowed to DO), not by file-path
permissions. Narrowing to specific files would re-introduce the exact frozen-list
stall problem for state files (a new state file = a new stall), for no real safety
gain. So: broad Write/Edit is correct; do not tighten.

## Consequences

- A new mandatory worker script "just works" for live workers — no re-grant, no
  respawn, no stall.
- Still no arbitrary-command capability (dir-scoped python only).
- Relationship to ADR-0018 (per-role dirs): if/when core roles get per-role
  `.claude/settings`, this same dir-glob rule is what those settings carry — one
  maintained allowlist per role rather than a per-spawn write. This ADR is the rule;
  0018 is where it could live for non-worker roles. Workers keep getting it written
  into their worktree at spawn (they are ephemeral per-PR, no shared role dir).
- The v42 changelog note ("existing workers need a re-ensure/respawn to pick up new
  Bash rules") is obsoleted for the mandatory-script case — the dir glob makes the
  grant future-proof.
