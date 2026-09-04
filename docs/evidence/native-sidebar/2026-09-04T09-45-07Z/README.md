# Proving the verification skill itself, 2026-09-04

One end-to-end run of `.claude/skills/verify-ccs-native-sidebar/` against the checkout at
`b0425f0`, to prove the skill's own instructions execute.

- **Launch.** `bun install --frozen-lockfile`, then `bun run bin/ccs sidebar serve --port 8799`
  from this worktree. The instructions were missing the install step until this run failed on
  `Cannot find package 'smol-toml'`; the skill now says so.
- **Doctor.** `doctor.txt` — the worktree server reports `serverVersion: dev`, the installed appex
  is `17d8c22` against a `b0425f0` checkout, and the category registry read fails at a path the
  vault no longer uses.
- **Drive (`features/queue.md`).** `ccs-sidebar-render queue.png 8 active 8799` and the matching
  snapshot query. `queue-rows.txt` lists the first eight rows the server returned; `queue.png` is
  what the shipped views draw for them, each row at rest and hovered.
- **Read.** The eight titles, their order, their projects and models, and the focused row match
  between the two. The hovered copies carry all four controls (save, done, close tab, summary).
  No category marks appear on any row, which agrees with the registry error above rather than
  contradicting it.
- **Cleanup.** The 8799 server was killed by PID; 8787 (the user's resident agent) still answers,
  and this directory survived the teardown.

Also found, and left alone as out of scope: the `⌘1`–`⌘9` jump badges are painted but never
invoked (`SessionListView.onJump` has no caller), and `docs/sidebar-concepts.md` describes a
`PointerWatch.swift` that this tree does not have.
