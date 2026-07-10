/**
 * `ccs bump-session` — the one reliable wake primitive (ADR-0028). Deliver-and-wake:
 * write the message to the recipient's durable inbox (ADR-0033) AND, if the recipient has a
 * live tab, nudge it so a non-looping worker notices now instead of on its next start.
 *
 * The MESSAGE is always durable (it's the inbox); the WAKE is best-effort. If the session is
 * closed, or the keystroke is dropped, nothing is lost — the mail drains on next start. This
 * is the single owned implementation that replaces every hand-rolled `cmux send` + send-key.
 */
import { execFileSync } from "node:child_process";
import type { Bridge } from "../cmux/bridge.ts";

export interface BumpPlan {
  /** always true — the message is written to the durable inbox regardless of liveness */
  deliver: true;
  /** whether to also nudge a live tab */
  wake: boolean;
  /** the surface to nudge (the exact terminal running the session), or null if closed */
  surfaceRef: string | null;
}

/** Decide deliver+wake vs deliver-only from the recipient's liveness (pure). */
export function planBump(bridge: Bridge, sessionId: string): BumpPlan {
  const loc = bridge.locateSession(sessionId);
  return {
    deliver: true,
    wake: loc !== null,
    surfaceRef: loc?.surfaceRef ?? null,
  };
}

/**
 * Wake a live surface: send a short nudge line + Enter. Best-effort and time-bounded — a
 * wedged cmux socket must never block the caller. Returns whether the nudge landed cleanly.
 */
export function wakeSurface(surfaceRef: string, note: string, cmuxBin = "cmux"): boolean {
  try {
    execFileSync(cmuxBin, ["send", "--surface", surfaceRef, "--", note], {
      timeout: 3000,
      stdio: "ignore",
    });
    execFileSync(cmuxBin, ["send-key", "--surface", surfaceRef, "--", "Enter"], {
      timeout: 3000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false; // dropped wake -> mail still waits; recipient picks it up on next start
  }
}
