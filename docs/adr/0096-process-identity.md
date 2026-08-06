# CCS process identity is an argv launch contract

Decided 2026-08-05.

## Context

Bun does not implement `process.title` on macOS. Copying or renaming the Bun executable would make Activity Monitor labels more distinctive, but it would also create an interpreter deployment problem unrelated to CCS identity.

macOS does preserve a caller-supplied `argv[0]`. A zsh launch seam can therefore apply a useful process label with `exec -a` while libproc and Activity Monitor continue to report the real Bun executable.

## Decision

The public direct entrypoint `bin/ccs` launches through zsh and applies this identity:

    ccs:<role>[@<ref>]

Role and ref segments match `[a-z0-9]+(?:-[a-z0-9]+)*`. The role comes from the first CLI subcommand with `main` as the safe fallback. Ref precedence is `PROCID_REF`, linked-worktree task slug, non-default branch, then omission. `PROCID` replaces the complete identity after strict validation. `PROCID_OFF=1` disables identity.

The direct `bin/ccs` entrypoint and the package `ccs` script are identity-bearing launch paths. The package script executes `./bin/ccs` directly rather than starting Bun first.

`bin/ccs` remains a zsh/TypeScript polyglot. Explicit `bun bin/ccs` invocation remains compatible, but it bypasses argv identity because Bun is already the process by the time the file loads.

Identity controls are launch inputs only. `PROCID`, `PROCID_REF`, and `PROCID_OFF` are removed before Bun starts so nested processes derive their own identities.

The implementation changes argv only. `ps -o args=` exposes the CCS identity; libproc and Activity Monitor continue to identify the executable as Bun.

Existing installed LaunchAgents remain outside this pilot. They continue using their current explicit Bun paths until a separate change migrates them to a PATH-correct direct source and intentionally reinstalls them. This pilot does not modify tracked or installed LaunchAgents.

## Consequences

- Operators can distinguish live CCS commands in argv-aware process tools without interpreter clones.
- Direct and package-script launches share one identity contract.
- Explicit Bun-first callers retain execution compatibility without claiming identity coverage.
- Nested CCS processes do not inherit their parent's identity overrides.
- LaunchAgent migration remains an explicit deployment operation rather than an incidental side effect of this pilot.
