# Error-Handling Patterns

Consistent error-handling idioms for ccs (ADR-0066/0071). One pattern per failure class, chosen once and written down so new code follows the same contracts.

## 1. Result<T, E> at fallible boundaries

**Use for**: operations that can fail for reasons the caller must distinguish from success.

**When**: The function is an I/O boundary (filesystem, network, external process) or performs fallible parsing/validation, AND the caller needs to handle the error differently from success.

```typescript
import { type Result, ok, err } from "./result.ts";

function readConfig(path: string): Result<Config, Error> {
  try {
    const raw = readFileSync(path, "utf8");
    return ok(JSON.parse(raw));
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// Caller is type-forced to handle the error case
const result = readConfig("/etc/app.json");
if (!result.ok) {
  log.error("Config load failed", { error: result.error.message });
  return;
}
const config = result.value;
```

**Boundary functions using Result** (as of ADR-0071):
- `locate.ts`: `locateLaunchDir`, `decodeStorageFolder` — distinguish I/O errors from legitimate absence
- `inference.ts`: `runStructured` — LLM call failures vs. valid (empty) responses
- `resolve-config.ts`: configuration resolution that can degrade or fail
- `cmux/live.ts`: `liveBridge` — unreadable liveness must fail closed (already has `readable` flag; Result formalizes it)

**Do NOT use Result for**:
- Pure functions with no failure mode
- Legitimate absence (missing file, no match, empty inbox) — those are `Ok(null)` or `Ok([])`, not errors
- Programmer errors (type violations, unreachable code) — those throw

## 2. null/undefined for legitimate absence

**Use for**: a query found nothing, but that's a valid outcome, not an error.

```typescript
function getRow(db: Database, id: string): SessionRow | null {
  // Missing row is fine — absence, not failure
  return db.query("SELECT * FROM sessions WHERE id = ?", id).get() ?? null;
}
```

**Absence is NOT the same as unreadable**: A missing file is `Ok(null)` or just `null`. A file you tried to read but couldn't (permissions, I/O error) is `Err(...)`. ADR-0066 fixes the bugs where these were conflated.

## 3. throw for programmer errors

**Use for**: violations that indicate a bug in the caller, not a runtime condition.

```typescript
function encode(value: string | number): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError(`encode: expected string|number, got ${typeof value}`);
  }
  return String(value);
}
```

**When to throw**:
- Type violations not caught by TypeScript (e.g., external data)
- Contract violations (calling a function with invalid arguments)
- Unreachable code paths (exhaustiveness checks)

**Do NOT throw** for expected runtime failures (missing file, network timeout, invalid user input) — those return `Result` or null.

## 4. Logging errors: tryOrLog and explicit logging

**Use `tryOrLog`** (from `logger.ts`) for fail-open-but-logged operations — best-effort work where failure is acceptable but must be visible:

```typescript
import { tryOrLog } from "./logger.ts";

// Best-effort tab paint: failure doesn't block the session, but should log
const painted = tryOrLog(
  () => paintTab(sessionId),
  false,
  { message: "Failed to paint cmux tab", context: { sessionId } }
);
```

**Use explicit `log.error`/`log.warn`** when you need custom logic after the error:

```typescript
try {
  const doc = readDoc(path);
  // ...
} catch (error) {
  log.error("Corrupt state document, quarantining", {
    path,
    error: error instanceof Error ? error.message : String(error),
  });
  quarantine(path);
  return null;
}
```

**Rule**: No silent catch blocks. Every `catch {}` or `catch { /* fail-open */ }` must either:
1. Log via `tryOrLog` or explicit `log.*` call, OR
2. Have a comment explaining why swallowing is correct (e.g., a fallback that logs elsewhere)

## 5. Fail closed vs. fail open

**Fail closed** (return an error, abort the operation) when:
- The error could cause incorrect behavior if ignored (e.g., resuming in the wrong directory)
- The operation mutates state or spawns processes
- The caller has a safe fallback or can surface the error to the user

**Fail open** (log the error, continue with defaults or degraded behavior) when:
- The operation is best-effort (cosmetic, caching, tab paint)
- Blocking would be worse than degraded functionality
- The error doesn't compromise correctness or safety

**ADR-0066 principle**: Fail closed for spawn/mutate decisions. Fail open only when proceeding is safer than aborting, AND the error is logged so it's visible.

## 6. Log levels

From `logger.ts`:

- **`log.debug`** — diagnostic detail, gated by `CCS_DEBUG` env var. Use for verbose tracing.
- **`log.info`** — informational messages (e.g., "synced 5 roles"). Not errors, just progress.
- **`log.warn`** — recoverable issues that might indicate a problem (e.g., stale config, deprecated path).
- **`log.error`** — actual errors that degraded or failed an operation (I/O failures, parse errors, hook crashes).

**Do NOT use** `console.error`/`console.warn` for diagnostics — those are unstructured and timestampless. Use the logger. Keep `console.log` only for user-facing CLI output (command results, not diagnostics).

---

**Summary hierarchy**:

- **I/O boundary can fail** → `Result<T, E>`, caller handles it
- **Legitimate nothing** → `null` or `Ok(null)`
- **Programmer error** → `throw`
- **Best-effort that logs** → `tryOrLog` or explicit `log.error` + proceed
- **Critical for correctness** → fail closed (return error / abort)
- **Cosmetic / safe to skip** → fail open + log

See ADR-0066 and ADR-0071 for the design rationale.
