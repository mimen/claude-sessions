import { err, ok, type Result } from "../result.ts";

export interface DelegateCliArgs {
  readonly seat: string;
  readonly parentSessionId: string;
  readonly parentIsCurrent: boolean;
  readonly cwd: string;
  readonly prompt: string;
  readonly seatsRoot: string | null;
}

const VALUE_FLAGS = new Set(["--child-of", "--cwd", "--prompt", "--seats-root"]);

function flagValue(args: readonly string[], flag: string): string | null {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1) || null;
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value) return null;
  return value.startsWith("--") && VALUE_FLAGS.has(value.split("=", 1)[0]!) ? null : value;
}

export function parseDelegateArgs(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Result<DelegateCliArgs> {
  const seat = args[0];
  if (!seat || seat.startsWith("--")) return err(new Error("Usage: ccs delegate <seat> --child-of <uuid|.> --cwd <directory> --prompt <task>"));

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
  });
}
