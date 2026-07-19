# CLAUDE.md is a hook, so a session's run-location is free config — supersedes ADR-0036's tradeoff

Supersedes the core tradeoff of ADR-0036 ("cwd = the role dir, and we accept losing the target
repo's CLAUDE.md auto-load"). Decided with Milad 2026-07-10. Design docs:
`docs/hook-resolution-draft.html` §00 + `docs/hook-instantiation-pr-watch.html` §00.

## What changed since ADR-0036

ADR-0036 framed a binary with an owned cost: put a worker's cwd in the role dir (uniform,
drift-free permissions) and lose the repo's CLAUDE.md / `.claude` auto-load; or put cwd in the
worktree and reintroduce per-worktree injected settings. That binary only exists if CLAUDE.md
loading is tied to cwd. **Once `claude-md` is a ccs hook (ADR-0043) — injected from the row, not
auto-loaded from cwd — the tie is cut.**

## Decision — three decoupled things

1. **`spawn-location` is per-role config** (most-specific-wins, ADR-0044). Whatever's opportune:
   a worker in its PR worktree (bonus: the repo's own CLAUDE.md + lint/hooks auto-load on top);
   a loop in its role dir. cwd drops from an architectural decision to a convenience knob.
2. **`claude-md` is the layered hook** that injects who-you-are / constitution / epic / role,
   regardless of cwd. This is what makes location stop mattering.
3. **Permissions come from row-resolution + `additionalDirectories`** (ADR-0036 kept this),
   never from a file injected into the worktree.

## Precedence — ccs config is authoritative; repo config is contextual

Moving a worker's cwd into the worktree reintroduces CC-native discovery as a second config
plane, so the precedence must be explicit (cross-model review, 2026-07-10):

- **ccs-resolved `claude-md` / permissions are authoritative.** The repo's own `CLAUDE.md` is
  CONTEXTUAL (helpful conventions), never overriding a ccs floor section.
- **`additionalDirectories` governs permissions, not instruction precedence** — do not conflate
  "can read/write here" with "whose hooks/instructions win."
- A worker's ccs `claude-md` should note it may read the target repo's CLAUDE.md for conventions,
  but ccs invariants (the gate, push≠post) always outrank repo guidance.
- Repo-native `.claude` hooks auto-running in the worktree is acceptable for a coding worker
  (same as a human running claude there) but is a known consequence, not a silent one.

## Consequences

- The roles registry gains a `spawn-location` notion; for `pr-agent` it resolves per-work-unit
  (the worktree), for loops it's the role dir.
- ADR-0036's "single fixed dir, not a template" stance is superseded for `pr-agent`: spawn-
  location is per-work-unit. Its uniform-permissions win is preserved via row-resolution, not by
  pinning cwd.
- Interacts with the worker spawn contract (ADR-0047): spawn-location resolution is step 2 of
  being born correct.
