# ccs verification map

What a user can do with the ccs CLI and Go TUI, one file per feature. [`../SKILL.md`](../SKILL.md) holds launch, doctor, harnesses and cleanup. Each file has four sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with the ccs sandbox`, and `Gotchas`.

## Baseline

- **A fresh sandbox per drive.** Never point a drive at `~/.ccs` or `~/.claude/projects`.
- **Session ids.** Use the synthetic ids in full: `11111111-1111-4111-8111-111111111111` and `22222222-2222-4222-8222-222222222222`.
- **Unreachable features.** A feature this sandbox cannot reach is reported with its prerequisite and the command tried. Never call it proved through another entry point.

## Features

| File | Read when |
|---|---|
| [index-and-list.md](index-and-list.md) | discovery, `reindex`, `ls`, `session <id>` reads, the catalogue daemon. Proved by `drive-cli.sh` |
| [title.md](title.md) | retitle from the CLI (`session title`, `rename`), attaching an indexed session to the catalogue. Proved by `drive-cli.sh` |
| [tui.md](tui.md) | the Go TUI: browse, search, dossier, retitle, and its known defects. Proved by `tui.sh` |
| [lifecycle.md](lifecycle.md) | save, complete, reopen, and why workspace close is out of reach in the sandbox |

## Out of scope in this sandbox

| Feature | Prerequisite it needs |
|---|---|
| resume (`enter`, `ccs resume`), `session new`, `start` | launches `claude` and opens cmux workspaces. Creates real sessions |
| enrichment, titling, TUI `S`, `A`, `E`, `D` | a model provider. Refused by the guards |
| `sync-tabs`, `session bump`, `reap-duplicates`, workspace close | cmux write verbs. Refused by the guard |
| `session destroy` | irreversible. Drive it only against a sandbox id, and capture the preflight manifest first |
| web sidebar (`ccs sidebar serve`) | serves the sandbox on a spare port. Rows are empty while cmux liveness is unreadable. Not mapped yet |
| native sidebar | [verify-ccs-native-sidebar](../../verify-ccs-native-sidebar/SKILL.md) |
