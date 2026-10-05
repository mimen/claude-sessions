# Index and list

ccs finds every `*.jsonl` transcript under the configured store, parses its title, cwd, model and cost, and keeps them in `CCS_ROOT/cache/index.db`. `ccs ls` prints them newest first with lifecycle, project, category, age and cost.

## Sub-features

- `ccs reindex` is incremental and reports scanned, parsed, unchanged, removed, and total API-equivalent spend.
- `ccs ls` hides saved and completed sessions. `--all` shows them, and `--category <slug>` filters.
- `ccs session <id> --json` reads one session. The state is `indexed-unattached` until it has a catalogue row, then `catalogued`.
- The catalogue daemon serves reads on `CCS_ROOT/run/native-catalogue-v1.sock`. It starts on demand and exits after 30 seconds idle.

## How to get to it (user POV)

Run `ccs reindex` once, then `ccs ls`. A session's detail comes from `ccs session <id>`.

## Driving it with the ccs sandbox

`drive-cli.sh <evidence-dir>` covers all of this. The proof is `Indexed 2 sessions (883 B) from <sandbox>/store [host: ccs-verify]`, both synthetic titles in `ls`, and `"state": "indexed-unattached"` with `"title": "Verify alpha session"` in the JSON read of `11111111-…`.

## Gotchas

- `ls` warns `Failed to read category registry` when `CCS_CATEGORY_REGISTRY_PATH` points at a missing file. The sandbox leaves it unset, so the real vault registry is read, read-only.
- Store discovery skips symlinks, so a symlinked fixture store indexes nothing.
- `ccs catalogue-service check` auto-starts a daemon for whichever `CCS_ROOT` is active. Run it only with the sandbox env, or it starts one for `~/.ccs`.
