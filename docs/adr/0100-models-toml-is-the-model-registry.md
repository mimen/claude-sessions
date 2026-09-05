# models.toml is the model registry

Decided 2026-09-05.

## Context

Adding a model meant editing fifteen places, six of them enumerations that had to agree and did not.
An audit found `availableModels` listing 22 ids, the `/model` picker 9, the AGENTS.md routing table
9, launcher `serves` globs about 9 via wildcards, and opencode 20-odd. No two agreed.
`claude-haiku-4-5` was allowlisted while the gateway served only the dated `-20251001` spelling, and
`gpt-5.5` was allowlisted while the `claudex` wrapper refused it.

Inside ccs the same facts were spread across five hard-coded tables: birth vocabulary and launcher
patterns in `role-model-launch.ts`, prices in `cost.ts`, family colours in `display/format.ts`,
labels in `sidebar/projection.ts`, and the enrichment model in `enrich/gateway.ts`. Grok and GLM
were in none of them, so those sessions priced at zero and rendered with no family badge.

## Decision

`ClaudeConfig/models.toml` is the only place a model's id, family, context window, launcher
membership, label, colour, price and birth eligibility are written. ccs reads it at runtime through
`routing.models` (default `~/.ccs/models.toml`, normally a symlink into the vault), exactly as it
already reads the launcher and launch-location registries. The hard-coded tables are deleted.

Four layers, and which of them this file owns:

| Layer | Question | Owned here |
|---|---|---|
| Reachability | can the gateway route this id at all? | no, but `ccs doctor models` cross-checks the live `/v1/models` against every active row |
| Offer | what does each client show and accept? | yes: `ccs launcher install` generates the Claude Code allowlist and picker per launcher, the launcher's tier-slot environment, opencode's model map, and T3 Code's custom model list |
| Policy | who uses which model for what? | no. The registry says nothing about what a model is for, so routing policy can be rearranged without touching it; the doctor only refuses a policy file naming an id the registry does not have |
| Tooling | how does ccs price, colour, label and attribute a model? | yes, read at runtime |

### The context-window accounting contract

This is the rule the file exists to make mechanical. Two spellings exist for a Claude model: the
canonical id (`claude-opus-5`) is CCS routing data, and the direct declaration (`claude-opus-5[1m]`)
is what Claude Code must see in any setting it reads without a wrapper in between. A bare Fable,
Opus or Sonnet id in `settings.model`, `availableModels`, `modelPicker.options[].model`, a
model-bearing env var, agent frontmatter, or a launcher env slot short-circuits custom-model
handling and silently drops to 200K nominal, observed as `effectiveWindow=180000`.

Claude Code has no per-model context field for a custom id. Its catalogue schema does carry
`context_window` and `behaves_as` per row, but that catalogue is fed only from Anthropic's org
model-selector endpoint or a signed published document, both gated behind a server-side flag,
first-party auth, and a signature check that a user-level `--settings` file cannot reach. So a
family declares which of the three available levers accounts for its window:

| accounting | mechanism | window Claude Code uses |
|---|---|---|
| `marker` | append the family marker (`[1m]`, or `""`) | the marked id's own window |
| `behaves_as` | map the row onto a known Claude id | that donor's window |
| `envelope` | no mapping | the launcher's `CLAUDE_CODE_MAX_CONTEXT_TOKENS` slot |

`behavesAs` on a GPT-5.6 row is the trap this encodes against: Claude Code adopts the donor's 200K
and stops honouring `CLAUDE_CODE_MAX_CONTEXT_TOKENS=921000`, so a 921K model compacts at 200K with
no error. `pickerRows()` therefore emits `behavesAs` only for a `behaves_as` family, the loader
refuses a `behaves_as` key on any other accounting mode, and the doctor errors on a picker row whose
mapping disagrees with its family.

Grok is the deliberate undercount. Its real window is 500K, which matches neither 200K nor the 921K
envelope; the registry accounts it at 200K through Sonnet 5 because an undercount compacts early
while an overcount fails mid-session, and the doctor prints the 300K left unused as a note rather
than a finding. GLM is 1M upstream and takes the envelope, so its former `behavesAs` mapping, a 200K
degradation, is gone.

### Why ccs reads the file rather than generating TypeScript

Generating a TypeScript table from the vault would put a repository landing in front of every model
change: add a row, regenerate, commit, push, deploy, on two machines. Reading the file at runtime
makes adding a model one vault edit plus `ccs launcher install`, and it is the same mechanism the
launcher fleet and the location registry already use, so there is no new concept and no checked-in
copy to keep in sync.

The cost is that a launch path now depends on a file outside the repository. That is answered by
where each caller sits: launch and compile paths take `requireModelRegistry()` and fail loudly,
because compiling a birth against a guessed fleet lands a session on the wrong subscription, while
display paths take `displayModelRegistry()`, warn once, and render sessions unpriced with an `other`
badge rather than refusing to open the list. Tests never read the vault file: `bunfig.toml` preloads
a fixture path so every suite resolves the checked-in `src/models/fixtures/models.toml`.

Model ids are branded strings parsed against the registry rather than string-literal unions. A
literal union is a build-time list that can disagree with the file; a brand can only be minted by
`parseBirthModel`, so a value carries the type precisely because the registry admitted it.
`ROLE_MODEL_IDS` stays authored in code because it is policy, not availability, and the doctor
checks it against the registry instead of the type system doing it.

### Why claude-gpt55 and local-mlx are gone

Claude Code's context ceiling is per process, so a model whose window matches no existing launcher
needs its own launcher. `claude-gpt55` existed only because `gpt-5.5` is 272K and could not share
`claudex`'s 921K envelope; `local-mlx` existed only for `qwen3.8-local` at 262K. Nothing routes to
either model now, and a launcher per stray window is not a fleet worth carrying: the fleet is
`claudex` (gateway, mixed 1M Claude and 921K GPT) and `claude-native` (direct Anthropic, the only
one with claude.ai connectors and Remote Control). Both models stay reachable at the gateway by raw
POST and from Hermes or opencode, and both keep `[[historical]]` rows so their transcripts still
price and badge correctly.

The name `claude-gpt` goes with them. Transcripts born on it still resume: routing keys on the
`serves` globs of today's fleet against the transcript's last model, never on a recorded binary
name, so a `gpt-5.6-sol` session resolves to `claudex` whatever wrote it.

## Consequences

- Adding a model is one `[[model]]` row, `ccs launcher install`, and `ccs doctor models`. A new
  context window is a `[[family]]` row first, and a window no launcher's envelope can host means a
  new launcher or no interactive access.
- Retiring one is `picker = false` or a move to `[[historical]]`; a model the gateway still
  advertises keeps its row with `replaced_by` so old births and transcripts resolve.
- A launcher's `serves` globs in the fleet and a model's `launchers` list in the registry can
  disagree. The registry wins for generation, and the doctor reports the mismatch. `serves` is not
  derived from the registry because the launcher matcher consumes it for transcript attribution,
  including a `grok-*` glob covering xAI's `grok-4.5-build` response spelling, which has no row.
- The registry's `[slots.<launcher>]` table overlays the effective launcher fleet, winning over the
  same key in `launchers.toml`, so an explicit `--via` spawn and the interactive shim install the
  identical environment. The doctor warns while a fleet entry still spells a key the registry sets.
- `ccs doctor models` reaches the network. An unreachable gateway is a warning, never a failure.
