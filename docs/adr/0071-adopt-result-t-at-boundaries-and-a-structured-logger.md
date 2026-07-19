# Adopt Result<T> at fallible boundaries and a structured logger

Decided with Milad 2026-07-11 from the error-handling audit's two lower-priority items. Milad chose to do
both (not defer). Complements ADR-0066 (the fail-open/absent-vs-unreadable correctness fix) by making the
error-handling *style* consistent and observable, not just correct.

## The two inconsistencies

1. **`Result<T>` is used by only 4 modules** (`config`, `store`/`scanStore`, `skills/scan`,
   `skills/archive`); everything else that can fail returns `T | null` or a struct with a flag
   (`liveBridge` → `readable`, `resolve-config` → `degraded`, inference → `unknown | null`,
   `locate` → `{kind:"absent"}`). So a caller has no consistent signal for "did this fail?" — sometimes a
   null, sometimes a flag, sometimes a thrown error.

2. **No structured logging.** 82 `console.error`/`console.warn`/`process.exit` sites, no levels, no
   timestamps, no context. Fine for a one-shot CLI, but the fleet runs long-lived loop roles + an engine —
   diagnosing "why did resume abort at 2am" means grepping unstructured stderr.

## Decision

1. **Adopt `Result<T, E>` at every fallible boundary — the function returns a value OR an error, never
   both, and the caller is type-forced to handle the error.** Convert the boundary functions that currently
   return `T | null` / flags for *failure* (not for legitimate absence): inference `runStructured`,
   `resolve-config` (degraded → an error arm), `locate` (absent-vs-unreadable from ADR-0066 becomes a
   `Result` where unreadable is the `E`), and the cmux read layer where `readable:false` is really an error.
   - **Keep `null`/absence for genuine "not there"** — a missing row, an empty inbox, no match. `Result`'s
     `E` is for *failure*, absence is a legitimate `Ok(null)`/`Ok([])`. This is the ADR-0066 distinction
     expressed in the type: absent = Ok(empty), unreadable = Err.
   - Document the rule in a short `docs/PATTERNS.md`: Result at fallible I/O boundaries; null only for
     legitimate absence; throw only for programmer errors / unreachable. One idiom, written down, so new
     code doesn't reinvent the split.

2. **Add a structured logger** (`src/logger.ts`): leveled (`debug`/`info`/`warn`/`error`), timestamped, with
   a context field, JSON-lined to stderr. Replace the `console.*` diagnostic sites with it. Gate `debug`
   behind `CCS_DEBUG` (ties to the ADR-0066 "log the swallowed error" requirement — those logs go through
   this). User-facing CLI output (the intentional `console.log` of command results) stays plain stdout —
   the logger is for diagnostics, not for the CLI's actual output.

## Why do it now (Milad's call), with the guardrails

- These were rated low-priority *individually*, but ADR-0066 is already touching every catch site — doing
  the Result conversion + routing swallowed errors through the logger *in the same pass* is cheaper than a
  separate sweep later. They're naturally the same edit.
- The guardrail that keeps this from being churn-for-aesthetics: **only fallible boundaries convert**, and
  **absence stays null**. We are not Result-ifying pure functions or legitimate empties. That bounds the
  blast radius to the ~dozen boundary functions the audit named.

## Consequences

- `Result<T, E>` (already exists) applied to inference, resolve-config, locate, cmux-read boundaries;
  callers handle `Err` explicitly (which for spawn/mutate paths means fail closed — CI-2 / ADR-0066).
- `src/logger.ts` added; `console.error`/`warn` diagnostic sites migrated; `CCS_DEBUG` gates debug. CLI
  result output unchanged.
- `docs/PATTERNS.md` records the error-handling idiom (Result vs null vs throw) so it's a decided contract,
  not per-author taste — resolving the audit's "inconsistent, new code doesn't know which to follow."
- Best done alongside ADR-0066 (same files); sequence them together.
