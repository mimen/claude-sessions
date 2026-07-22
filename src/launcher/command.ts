import { installClaudeShim } from "./install.ts";

export function launcherCommand(args: readonly string[]): number {
  const subcommand = args[0];
  if (subcommand !== "install") {
    console.error("usage: ccs launcher install");
    return 2;
  }

  const result = installClaudeShim();
  if (!result.ok) {
    console.error(`ccs launcher install: ${result.error.message}`);
    return 1;
  }
  console.log(JSON.stringify({ status: "OK", ...result.value }));
  return 0;
}
