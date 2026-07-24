import { err, ok, type Result } from "../result.ts";

export interface DelegateCliArgs {
  readonly seat: string;
  readonly parentSessionId: string;
  readonly parentIsCurrent: boolean;
  readonly cwd: string;
  readonly prompt: string;
  readonly seatsRoot: string | null;
  readonly useFallback: boolean;
}

const VALUE_FLAGS = new Set(["--child-of", "--cwd", "--prompt", "--seats-root"]);
const NO_VALUE_FLAGS = new Set(["--fallback"]);

function flagValue(args: readonly string[], flag: string): string | null {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1) || null;
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value) return null;
  const valueFlag = value.split("=", 1)[0]!;
  return value.startsWith("--") && (VALUE_FLAGS.has(valueFlag) || NO_VALUE_FLAGS.has(valueFlag)) ? null : value;
}

function fallbackSelection(args: readonly string[]): Result<boolean> {
  const fallbackArgs = args.filter((arg) => arg === "--fallback" || arg.startsWith("--fallback="));
  if (fallbackArgs.length === 0) return ok(false);
  if (fallbackArgs.length !== 1 || fallbackArgs[0] !== "--fallback") {
    return err(new Error("ccs delegate accepts --fallback at most once and without a value"));
  }
  return ok(true);
}

export function parseDelegateArgs(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Result<DelegateCliArgs> {
  const seat = args[0];
  if (!seat || seat.startsWith("--")) return err(new Error("Usage: ccs delegate <seat> [--fallback] --child-of <uuid|.> --cwd <directory> --prompt <task>"));

  const fallback = fallbackSelection(args);
  if (!fallback.ok) return fallback;

  const childOf = flagValue(args, "--child-of");
  if (!childOf) return err(new Error("ccs delegate requires --child-of <uuid|.>"));
  const parentSessionId = childOf === "." ? environment.CLAUDE_CODE_SESSION_ID : childOf;
  if (!parentSessionId) {
    return err(new Error("--child-of . requires CLAUDE_CODE_SESSION_ID in the parent session environment"));
  }

  const cwd = flagValue(args, "--cwd");
  if (!cwd) return err(new Error("ccs delegate requires --cwd <directory>"));
  const prompt = flagValue(args, "--prompt");
  if (!prompt) return err(new Error("ccs delegate requires --prompt <task>"));

  return ok({
    seat,
    parentSessionId,
    parentIsCurrent: childOf === ".",
    cwd,
    prompt,
    seatsRoot: flagValue(args, "--seats-root"),
    useFallback: fallback.value,
  });
}
