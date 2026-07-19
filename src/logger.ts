/**
 * Structured logger for ccs diagnostics (ADR-0071). Leveled, timestamped, JSON-lined to
 * stderr, with context fields. User-facing CLI output stays on plain stdout.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  message: string;
  context?: Record<string, unknown>;
}

const CCS_DEBUG = process.env.CCS_DEBUG === "1" || process.env.CCS_DEBUG === "true";

function write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (level === "debug" && !CCS_DEBUG) return;
  const entry: LogEntry = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...(context && { context }),
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const log = {
  debug(message: string, context?: Record<string, unknown>): void {
    write("debug", message, context);
  },
  info(message: string, context?: Record<string, unknown>): void {
    write("info", message, context);
  },
  warn(message: string, context?: Record<string, unknown>): void {
    write("warn", message, context);
  },
  error(message: string, context?: Record<string, unknown>): void {
    write("error", message, context);
  },
};

/**
 * Run a fallible function; on throw, log the error with context and return the fallback.
 * The fail-open-but-logged idiom from ADR-0066 — makes "fail-open and silent" stop being
 * the path of least resistance.
 */
export function tryOrLog<T>(
  fn: () => T,
  fallback: T,
  ctx: { message: string; context?: Record<string, unknown> },
): T {
  try {
    return fn();
  } catch (err) {
    log.error(ctx.message, {
      ...ctx.context,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}
