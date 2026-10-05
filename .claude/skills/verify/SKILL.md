---
name: verify
description: Drive the real ccs CLI and Go TUI against an isolated synthetic store and capture evidence that a change works. Use after touching src/, bin/ or tui-go/, before landing, or when a claim about indexing, listing, search, retitle, or lifecycle needs proof. Native cmux sidebar work goes to verify-ccs-native-sidebar.
---

# Verify ccs

`ccs` reads Claude Code transcripts from a store, indexes them into SQLite under a runtime root, and lets the user list, search, retitle and change lifecycle from the CLI or the Go TUI (bare `ccs`). This skill runs the real `bin/ccs` from this checkout against a throwaway world, Drives keep runtime writes in the sandbox, permit cmux reads, and refuse cmux/T3 writes and model calls.

| Surface | Skill |
|---|---|
| CLI and Go TUI | this one |
| Native cmux sidebar (`macos/`), live panel, appex install | [verify-ccs-native-sidebar](../verify-ccs-native-sidebar/SKILL.md) |

## Launch

There is no long-lived app. Every drive builds a fresh sandbox with [`sandbox.sh`](sandbox.sh):

```sh
bun install --frozen-lockfile                      # fresh worktree
sandbox_env=$(.claude/skills/verify/sandbox.sh /tmp/ccs-verify-<stamp>) || exit 1
eval "$sandbox_env"
.claude/skills/verify/doctor.sh || exit 1
./bin/ccs reindex                                  # "Indexed 2 sessions ... [host: ccs-verify]"
```

The sandbox holds `root/` (`CCS_ROOT`: config, index, catalogue, daemon socket), `store/` with two synthetic transcripts (`11111111-…` "Verify alpha session", `22222222-…` "Verify beta session"), and `bin/` guards that go first on `PATH`:

| Guard | Behavior |
|---|---|
| `cmux` | `tree`, `events`, `list-*`, `sidebar-state`, `--version` pass to the real cmux. Every other verb exits 97 and is logged to `cmux-calls.log` |
| `ccs` | `ccs enrich` exits 97 and is logged to `enrich-refused.log`. Lifecycle verbs detach it, and it would post a transcript to the model gateway |
| `t3`, `no-inference` | always exit 97. Config points codex and claude titling at `no-inference` |

The CLI spawns a catalogue daemon on the sandbox socket. It exits by itself after 30 seconds idle.

## Doctor

```sh
.claude/skills/verify/doctor.sh                    # with the sandbox env active
.claude/skills/verify/doctor.sh <evidence-dir>     # also checks owned processes
```

It prints the checkout SHA and whether `src/`, `tui-go/` or `bin/` are dirty. It confirms bun, go, sqlite3 and ttyd exist, that `CCS_ROOT` and the store sit inside the sandbox, and that both guards resolve first. With an evidence dir it checks every owned process. The pid, start time and argv must match the record, the process must hold its port, and it must come from this checkout. Exit 1 means do not drive.

## Drive

### CLI: one command, full proof

```sh
.claude/skills/verify/drive-cli.sh <evidence-dir>
```

It runs `reindex`, `ls`, `session <id> --json`, `session-fields <id> --json '{"customTitle":null}'` (attach), `session title`, readback, `ls`, then `session save` and `ls --all`. It writes `cli-transcript.txt`, `catalogue-row.txt` (read-only sqlite), `steps.txt` with exit codes, the guard logs, and `proof.json`. `proof.json` holds the source SHA, a dirty flag, helper hashes and named checks, and the script exits nonzero if any check fails. Drive single commands by hand with the same `eval` and `./bin/ccs …`.

### TUI: the real Go TUI in a PTY, in the browser

```sh
.claude/skills/verify/tui.sh start <evidence-dir> [port]   # fresh sandbox, owned ttyd, prints the URL
.claude/skills/verify/tui.sh url <evidence-dir>            # credentialed URL; pass it to the browser only
```

1. Open the T3 browser: `preview_status`, then `preview_open`, then `preview_navigate` to the credentialed URL. ttyd binds the tailnet interface because the T3 browser cannot reach this Mac's loopback. It runs `--once --check-origin` with a random BasicAuth credential in `<sandbox>/ttyd.cred` (mode 600). Never print it or put it in evidence.
2. `preview_recording_start` after the page loads. The page URL is then credential-free.
3. Click the terminal once to focus it. Send keys with `preview_press` and text with `preview_type` on `textarea[aria-label='Terminal input']`. Snapshot after every action and read the PNG.
4. `q`, then `preview_recording_stop`. Copy the video and screenshots into the evidence dir.
5. `tui.sh stop <evidence-dir>`. It copies guard logs and catalogue rows, redacts the credential from the owned record and the ttyd log, and runs teardown.

Keys and the CLI verb each one runs are in [features/tui.md](features/tui.md).

## Evidence

- **Location.** Proof lives outside the worktree, under `/Users/mimen/Documents/verification-proofs/claude-sessions/<run>/`. A helper refuses an evidence dir that exists.
- **Real path.** Every proof drives `bin/ccs` or the TUI keys. Seeding a SQLite row or calling an internal function is not proof.
- **Action and result.** Capture the before state, the action, and the after state. A mutation also needs its persisted row (`sqlite3 -readonly <sandbox>/root/cache/catalogue.db`) and its CLI readback.
- **Boundaries.** Attach `cmux-calls.log` and `enrich-refused.log` to every proof. A write verb in `cmux-calls.log` fails the proof.
- **Pin it.** Every `proof.json` records `source_sha`, `source_dirty` and `helper_sha256`.

## Cleanup

[`teardown.sh`](teardown.sh)` <evidence-dir> <sandbox>` runs at the end of both drive helpers. It adopts the sandbox's catalogue daemon from that sandbox's own lock file, so the user's daemon is never a candidate. It stops every owned process through [`own.sh`](own.sh), which kills only when pid, start time and argv still match. It removes the sandbox only if every stop succeeded and the daemon lock is gone, and otherwise keeps the sandbox and exits 1. Evidence is never touched.

Never `pkill` by name. The user's resident `ccs:catalogue-service` and `sidebar serve` processes match the same names.

## Helpers

| Script | Use |
|---|---|
| [`sandbox.sh`](sandbox.sh)` <dir>` | build the isolated world; print the env to `eval` |
| [`doctor.sh`](doctor.sh)` [<evidence-dir>]` | read-only readiness and owned-process check |
| [`drive-cli.sh`](drive-cli.sh)` <evidence-dir>` | the full CLI proof, with `proof.json` |
| [`tui.sh`](tui.sh)` start\|url\|stop <evidence-dir>` | serve the TUI over authenticated ttyd and tear it down |
| [`own.sh`](own.sh)` start\|adopt\|check\|stop\|stop-all <run-dir> …` | process ownership by recorded identity |
| [`teardown.sh`](teardown.sh)` <evidence-dir> <sandbox>` | stop owned processes; remove the sandbox only when they are gone |

## Features

[features/README.md](features/README.md) maps what a user can do, how to drive each feature, and which features this sandbox cannot reach.
