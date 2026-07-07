import { execFileSync } from "node:child_process";

export type ResumeTarget = "cmux" | "inline";
export type TargetPin = "auto" | "cmux" | "inline";

/**
 * Whether a cmux instance is reachable (its control socket answers `cmux ping`).
 * MUST be time-bounded: a wedged cmux socket accepts but never answers, and an unbounded
 * sync wait here blocks the Ink render thread with raw mode on — the TUI hard-freezes and
 * even ctrl-c is dead (SIGINT is handled in the blocked JS).
 */
export function cmuxReachable(binary = "cmux"): boolean {
  try {
    execFileSync(binary, ["ping"], { timeout: 1500, stdio: "ignore" });
    return true;
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
