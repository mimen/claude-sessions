# Permission mode is an embodiment policy, not birth policy

Decided 2026-07-27.

## Context

`ccs cluster resume event-watch` brought a fleet of unattended workers back sitting in `auto`, waiting on prompts nobody was there to answer — even though the operator's `~/.claude/settings.json` declares `permissions.defaultMode = "bypassPermissions"`.

Claude Code's documented behavior explains it. On resume:

1. `bypassPermissions` is **never** restored, whatever mode the session ended in.
2. The restored session mode **outranks** `settings.json` `defaultMode`.
3. An explicit `--permission-mode` flag outranks both.

So a session that drifted into `auto` mid-run comes back in `auto` forever, and the settings default can never claw it back. `buildResumeCommand` emitted no permission flag at all, which left ccs with no way to express a posture at the only point where it is enforceable: argv.

## Decision

A cluster (`cluster.toml`) or a role (`role.toml`) may author an optional `permission_mode` from Claude Code's closed vocabulary: `acceptEdits`, `auto`, `bypassPermissions`, `default`, `manual`, `dontAsk`, `plan`.

ccs applies it as `--permission-mode <mode>` at **every embodiment** — fresh birth (`ccs session new`) *and* resume (`ccs resume-session`, `ccs resume-cluster` / `ccs cluster resume`, TUI resume). Precedence at birth:

    explicit --permission-mode  >  role.toml  >  cluster.toml  >  loop ⇒ acceptEdits  >  none

The trailing `loop ⇒ acceptEdits` is the pre-existing unattended-loop default; it survives only as the floor beneath declared policy, since it existed purely because nothing could declare a posture. Resume has no such floor: role, then cluster, then no flag.

On resume the flag is inserted **after** `--resume <id>` and **before** the trailing resume command, because that command is a positional prompt — a flag after it would be swallowed as prompt text.

Validation is asymmetric, matching how each file already behaves.

`role.toml` stays fail-open on read but records an unknown value as `manifestError`, which `validateSpawn` already refuses to launch — a typo'd role posture blocks the birth.

`cluster.toml` errs at parse. A cluster that ships a manifest ccs cannot parse **refuses the birth** rather than silently falling back to the legacy default; a cluster with no manifest at all keeps the pre-existing warn-and-proceed path, since that is an ad-hoc cluster name, not a broken declaration.

Resume, by contrast, **fails open**: an unreadable or deleted config package must never strand a reachable transcript. But fail-open means *no enforced mode* — never *a more permissive one*. A role whose manifest didn't parse therefore resolves to no policy at all and does **not** inherit its cluster's: that role may have been declaring a narrower posture (`plan` under a `bypassPermissions` cluster) that we simply can't read, and inheriting upward would hand it more autonomy than its author asked for.

## Consequences

This deliberately inverts ADR-0091. Model policy is birth-only because resume is history-routed — a later `model` edit must not change which backend replays an existing transcript. Permission mode is the opposite kind of fact: not a property of the transcript at all, but the operating posture of the process about to run it. Because Claude Code drops that posture on resume, it has to be **re-asserted** every time the session is embodied, or an unattended cluster silently becomes attended.

An operator's explicit `--permission-mode` still wins everywhere: policy is a default, not a cage.

A cluster that declares nothing produces byte-identical argv to pre-ADR-0094 ccs.
