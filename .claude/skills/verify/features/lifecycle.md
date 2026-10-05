# Lifecycle

A user moves a session between Active, Saved and Completed. `ls` hides Saved and Completed unless `--all` is passed. Save and complete also start enrichment and close the session's cmux workspace.

## Sub-features

- `ccs session save|complete <id>` records the lifecycle, detaches `ccs enrich <id>`, then closes the workspace only when cmux proves that the session owns it.
- `ccs session unsave|uncomplete <id>` records the lifecycle only.
- `ccs finish-current <complete|save> [--do]` does the same for the calling session.

## How to get to it (user POV)

From the CLI, run `ccs session save <id>`. In the TUI, press `e` or `C`. The `/ccs:save` and `/ccs:complete` plugin commands do this from inside a session.

## Driving it with the ccs sandbox

`drive-cli.sh` runs `session save` on the alpha session. `ls --all` must then show it as `saved`, and `enrich-refused.log` must record the refused `ccs enrich`. The command exits 1 with `lifecycle recorded, but workspace close refused`. The close preflight finds the cmux bridge unreadable when the live socket is not reachable from the agent's shell, and a reachable socket would give `session-not-live`. Either way no workspace is closed.

## Gotchas

- **Unproved boundary.** Proving the workspace-close half needs a real session in a live cmux workspace. That creates a session and closes a real workspace, so this skill does not do it.
- `unsave` and `uncomplete` are pure catalogue writes and can be driven freely in the sandbox.
