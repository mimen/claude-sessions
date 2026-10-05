# Retitle

A user gives a session their own title, and it replaces the native or generated one in `ls`, the TUI and the sidebar. The title is stored as `custom_title` in `catalogue.db`.

## Sub-features

- `ccs session title <id> "text"` sets the title and tries to rename the session's cmux workspace.
- `ccs rename <id> "text"` is the same write without the catalogue check.
- `ccs session-fields <id> --json '{"customTitle":null}'` attaches an `indexed-unattached` session to the catalogue. The TUI runs it before every write.
- `ccs session unset <id> --title` clears it.

## How to get to it (user POV)

From the CLI, run `ccs session title <id> "…"`. In the TUI, press `t` on a row.

## Driving it with the ccs sandbox

`drive-cli.sh` attaches alpha, sets `Renamed by verify <HHMMSS>`, and reads it back three ways. The output must say `renamed → <title> (cmux not open / not synced)`. `ccs session <id> --json` must show `"customTitle"`. `catalogue-row.txt` must hold `<id>|<title>`.

## Gotchas

- `session title` on an unattached id fails with "is not catalogued". Attach it first.
- The cmux tab sync looks up the session's workspace with `cmux tree` and, when it finds one, runs `rename-workspace`. Synthetic sessions have no workspace, so the guard never sees a write. A drive against a live session would rename a real tab.
