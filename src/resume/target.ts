export type ResumeTarget = "cmux" | "inline";
export type TargetPin = "auto" | "cmux" | "inline";

/** Whether a cmux instance is reachable (its control socket answers `cmux ping`). */
export function cmuxReachable(binary = "cmux"): boolean {
  try {
    return Bun.spawnSync([binary, "ping"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the resume target. The config pin wins (`cmux`/`inline`); `auto` picks cmux when
 * it's reachable, else inline. `forceOther` (the in-TUI override key) flips the result so the
 * user can do the one-off opposite of the default.
 */
export function resolveTarget(pin: TargetPin, reachable: boolean, forceOther = false): ResumeTarget {
  const base: ResumeTarget =
    pin === "cmux" ? "cmux" : pin === "inline" ? "inline" : reachable ? "cmux" : "inline";
  if (!forceOther) return base;
  return base === "cmux" ? "inline" : "cmux";
}
