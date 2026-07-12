# The inference engine is pluggable — Codex or Claude, selected by availability

ADR-0001 titled sessions with the Codex CLI to avoid the API charges `claude -p` was
expected to incur, and explicitly left the door open: *"The titler sits behind a single
interface, so swapping back to `claude -p`, an SDK, or a local model is a one-file change if
the cost calculus flips."* This ADR walks through that door and generalizes it.

## Decision

`ccs` runs all LLM inference (title generation and the plain-English catalogue editor)
through one `InferenceEngine` interface in `src/inference/engine.ts`, with two interchangeable
backends:

- **codex** — `codex exec` run hermetically (ephemeral, read-only sandbox, user config/rules
  ignored), `--output-schema` forcing the JSON response. Rides existing ChatGPT/OpenAI auth at
  no marginal cost, so it stays the preferred backend for high-volume background titling.
- **claude** — `claude -p --strict-mcp-config --output-format json --json-schema <inline>`.
  The schema is passed inline (not a file path), and the parsed object comes back on the
  result envelope's `structured_output` field. Default model is `haiku` to keep titling cheap.

Both do the same job: pipe a bounded `stdin` payload, force a JSON schema, return the parsed
object or `null`. The titler and the catalogue command both delegate to whichever engine is
active — the two duplicated inline `codex exec` spawns are gone.

## Selection is availability-driven

`ccs` shouldn't offer an engine that isn't installed. `resolveEngine()` probes PATH and only
exposes installed backends. Precedence: `CCS_INFERENCE_ENGINE` env → in-TUI toggle (persisted
in `prefs.json`) → `inference.engine` config → `auto`. `auto` uses the first installed
backend, preferring `codex` for its free auth. An explicit request for a backend that isn't
installed falls back to the best available one rather than failing.

When **both** are installed, the TUI's `i` key cycles the active engine live (rebuilding the
titler and the metadata engine together, since Root owns both) and persists the choice. When
only one is installed there is nothing to swap to, so the toggle and its footer hint are
hidden.

## Notes

- The index still stores generated titles in the `codex_title` column with title-source label
  `"codex"`, and `src/titler/codex.ts` keeps its filename. These are now engine-agnostic
  labels; renaming them would be a schema migration for no user-visible benefit. Left as-is.
- `claude -p` warms a large cached system prompt on first call (~20k cache-creation tokens),
  so per-title cost is higher than Codex's free auth. That's the reason `codex` stays the
  `auto` preference and `claude` defaults to `haiku`.
