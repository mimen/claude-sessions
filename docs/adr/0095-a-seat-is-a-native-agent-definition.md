# A seat is a native agent definition, not a private registry

Decided 2026-07-28. Supersedes the seat-definition half of ADR-0090.

## Context

ADR-0090 put canonical seat definitions "outside auto-discovered `.claude/agents` paths": each seat
was a directory holding `seat.toml` (name, description, tools, skills, and a fixed `[routing.primary]`
/ `[routing.fallback]` pair of provider + launcher + model + effort) plus a `prompt.md`.

That bought separation and cost duplication. A role that Claude Code's native Agent tool could
dispatch and a role that `ccs delegate` could launch were two files in two formats in two places,
kept in sync by hand. Every seat edit was two edits, and the two representations drifted.

The premise that forced the split turned out to be false. Claude Code **tolerates unknown keys in
agent frontmatter** — verified empirically on 2026-07-28: a definition carrying `routing_fallback`,
`fallback_model`, and a nested arbitrary map loaded and dispatched normally. So one file can carry
both the keys Claude Code reads and the keys only ccs reads.

ADR-0090's other reason for a private launcher field also expired. It made each seat name its own
`provider` + `launcher` under a hard invariant (Claude → `claude-native`, GPT → `claude-gpt`). Once
`claudex` became one gateway process holding OAuth for both vendors, the launcher stopped being
derivable from — or constrained by — the model, and the daily driver became a fleet decision rather
than a per-seat one.

## Decision

A seat's definition is exactly one native Claude Code agent definition: `<agents-root>/<seat>.md`,
YAML frontmatter plus the role prompt as its body. The agents root is `~/.claude/agents` (per-machine
symlink to whatever canonical source that host syncs), overridable with `CCS_AGENTS_ROOT` or
`--agents-root`.

Frontmatter keys `ccs delegate` reads:

| Key | Required | Read by |
|---|---|---|
| `name`, `description`, `tools`, `model` | yes | Claude Code and ccs |
| `effort` | yes | ccs |
| `fallback_model` + `fallback_effort` | no, but both or neither | ccs only |
| `skills`, `permission_mode` | no | Claude Code and ccs |

Every other key is IGNORED rather than refused, in both directions. That tolerance is the contract,
not an implementation detail: a definition must stay loadable when Claude Code adds a key ccs has
never heard of, and vice versa. `tools` and `skills` accept a YAML list or Claude Code's
comma-separated string; a present-but-empty `tools` keeps the retired manifest's meaning — declare no
restriction, inherit every tool.

`--fallback` selects `fallback_model` + `fallback_effort` and still fails **before** the child is
reserved when the definition declares none. Half a fallback is an authoring error and fails at load,
rather than silently launching the primary model at the backup's effort.

A definition declares no provider and no launcher. Every delegated child is born on `claudex`, the
birth route default and the one launcher that reaches both vendors. Provider is derived from the
model prefix and recorded as catalogue provenance. Provider does not control routing.

Shared agent frontmatter is a direct Claude Code input. Full Fable, Opus, and Sonnet IDs therefore
carry the client-side `[1m]` context declaration. Haiku and non-Claude IDs remain unsuffixed. This
literal spelling also matters for settings and model-picker values because `/model` writes the
selected value back to Claude Code settings without passing through a launcher wrapper. GPT-5.6
picker rows omit `behavesAs`. Mapping one to a known Claude model also imports that model's 200K
window and prevents the launcher's 921K context declaration from applying.

`ccs delegate` removes `[1m]` when it loads a seat. It records the canonical model ID in route
provenance, then compiles that ID for the selected launcher. This keeps native Agent dispatch and
CCS delegation on one definition without storing client metadata in CCS routing data.

Everything else about delegation is unchanged: reservation of the auxiliary child and its causal edge
before launch, creator provenance, synchronous execution, exit-status passthrough, and no automatic
retry after a child starts.

## Consequences

- One file per role. The registry that was `seat.toml` + `prompt.md` is retired on the ccs side; the
  same file is now both the auto-discovered native agent and the delegated seat.
- A seat's model vocabulary stays free-form on purpose. ccs does not validate it against
  `BIRTH_MODEL_IDS`: the registry is authored outside this binary and may name a model a given ccs
  release has never heard of. A bad model fails at the launcher, loudly, instead of failing at load
  against a list that ships on a different cadence.
- ccs and Claude Code can no longer disagree about what a seat is, because they read the same bytes.
