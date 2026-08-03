import type { ResumeCommand } from "./command.ts";

/**
 * Hand the terminal to an interactive `claude` in the Session's cwd. MUST be called after the
 * Ink app has unmounted (terminal restored), so Claude owns the TTY. Blocks until Claude
 * exits; returns its exit code. This is the inline resume path.
 */
export function handoffInline(cmd: ResumeCommand): number {
  let result;
  // The launcher's `clears` are applied to the INHERITED environment before its assignments, so an
  // inline `--via claude-native` from inside a gateway session really does reach Anthropic.
  const environment: Record<string, string | undefined> = { ...process.env };
  for (const key of cmd.unset) delete environment[key];
  try {
    result = Bun.spawnSync(cmd.argv, {
      cwd: cmd.cwd,
      env: { ...environment, ...cmd.env },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (e) {
    console.error(`ccs: failed to launch ${cmd.argv[0]}: ${(e as Error).message}`);
    return 127;
  }
  // spawnSync doesn't throw for a missing binary — it returns success:false. Catch that so we
  // don't silently report success on a no-op resume.
  if (!result.success && result.exitCode == null) {
    console.error(`ccs: could not run "${cmd.argv.join(" ")}" — is \`${cmd.argv[0]}\` on your PATH?`);
    return 127;
  }
  return result.exitCode ?? 0;
}
