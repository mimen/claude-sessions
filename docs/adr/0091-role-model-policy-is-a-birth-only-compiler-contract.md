# Role model policy is a birth-only compiler contract

Decided 2026-07-23.

## Decision

A role may author an optional `model` in `role.toml`. The initial closed vocabulary is:

- `claude-opus-5`
- `gpt-5.6-terra`
- `gpt-5.6-sol`

The value is a canonical model ID only. Roles do not author provider, backend, launcher, or the gateway's `[1m]` spelling. `ccs new-session` compiles the value before UUID reservation:

- `claude-opus-5` → `claude --model claude-opus-5`
- GPT models → `claude-gpt --model <canonical>[1m]`

Malformed TOML, unknown model values, aliases, and `[1m]` input fail new-session preflight. A model-policy role also rejects explicit `--via` and `--model`; policy-less/manual roles keep existing `--via` behavior.

Curated launch locations reuse the same compiler for an authored `default_harness` + `default_model` pair. The pair is validated before reservation only when that default route is selected. Route precedence is role policy, explicit `--model`, explicit legacy `--via`, location default, then the established plain `claude` fallback. This keeps role policy authoritative, prevents a stale lower-priority default from blocking an explicit route, and leaves policy-less births unchanged when no route was requested.

The resolved model and launcher are written only as launch provenance metadata for audit and observability. They are not role truth and are not consulted by resume.

## Consequences

Fresh births are deterministic and reject invalid policy before catalogue reservation, spawn actions, or process launch. Inline and detached births share the same generated argv. Resume remains history-routed through the transcript model set and never receives a birth `--model` override, so a later role policy edit cannot alter replay backend or model.
