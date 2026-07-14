/**
 * `ccs bump-session <sid>` — send a wake nudge to a specific session id, resolved via the live
 * cmux bridge (surface UUID from the hook store, tree-intersected). Fails LOUD when the session
 * has no live surface: this is deliberate because the alternative (falling back to `cmux send
 * --workspace <stale-ref>`) landed nudges in whichever workspace happened to be focused when the
 * stored workspace ref had since been renumbered — the pr-watch symptom we chased 2026-07-13,
 * where 6 workers' re-assess nudges kept landing in the operator's active tab and every worker
 * stayed silent for hours.
 *
 * Contract:
 *   ccs bump-session <sid> [--note "<line>"]
 *
 * Exit codes:
 *   0    nudge delivered (send + Enter both succeeded)
 *   1    session id has no live surface — caller should treat this as "not delivered, message
 *        must already be durably queued elsewhere (inbox, etc.) or will be lost"
 *   2    liveness unreadable (cmux down / socket unauthed / hook store missing) — fail-closed
 *
 * Prints a JSON object with {status, sessionId, surfaceRef, note} for machine callers.
 */

import { execFileSync } from "node:child_process";
import { liveBridge } from "../cmux/live.ts";

interface Result {
  status: "delivered" | "not-live" | "unreadable" | "wake-failed";
  sessionId: string;
  surfaceRef: string | null;
  note: string | null;
}

function wakeSurface(cmuxBin: string, surfaceRef: string, note: string): boolean {
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
    return false;
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

export function bumpSessionCommand(args: string[]): number {
  const sid = args.find((a) => !a.startsWith("--") && a !== flag(args, "--note"));
  if (!sid) {
    console.error("usage: ccs bump-session <session-id> [--note \"<line>\"]");
    return 2;
  }
  const note = flag(args, "--note") ?? "[ccs] nudge";
  const cmuxBin = process.env.CCS_CMUX_BIN ?? "cmux";

  const bridge = liveBridge();
  if (!bridge.readable) {
    const r: Result = { status: "unreadable", sessionId: sid, surfaceRef: null, note };
    console.log(JSON.stringify(r));
    return 2;
  }
  const loc = bridge.locateSession(sid);
  if (!loc) {
    const r: Result = { status: "not-live", sessionId: sid, surfaceRef: null, note };
    console.log(JSON.stringify(r));
    return 1;
  }
  const ok = wakeSurface(cmuxBin, loc.surfaceRef, note);
  const r: Result = {
    status: ok ? "delivered" : "wake-failed",
    sessionId: sid,
    surfaceRef: loc.surfaceRef,
    note,
  };
  console.log(JSON.stringify(r));
  return ok ? 0 : 1;
}
