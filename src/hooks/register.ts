/**
 * SessionStart hook logic (ADR-0017) — the registration + arming safety net, made pure so
 * it's testable. The thin CLI wrapper reads the hook's stdin payload and calls this.
 *
 * Two jobs, gated by `source`:
 *  1. registration (all sources): a known session is refreshed; an unregistered one gets
 *     additionalContext telling the AGENT to self-register (the hook can't prompt the human).
 *  2. arming (source == resume): a resumed loop whose resume_command exists is flagged to
 *     re-arm — belt-and-suspenders for a bare `claude --resume` that bypassed ccs.
 *
 * Fail-open (ADR-0035): a malformed payload never throws; the session always proceeds. An
 * unregistered / un-armed session is reported `degraded` so the TUI can surface it.
 */
import type { Database } from "bun:sqlite";
import { getRow, touch } from "../catalogue/db.ts";

export interface SessionStartPayload {
  session_id: string;
  source: "startup" | "resume" | "clear" | "compact";
  cwd?: string;
  agent_type?: string;
  session_title?: string;
}

export interface SessionStartResult {
  registered: boolean;
  /** text injected for the agent before its first turn (ask-to-register / re-arm), or null */
  additionalContext: string | null;
  /** the resume_command to re-fire, if this is a bypassed loop resume; else null */
  reArm: string | null;
  /** true when the session isn't fully wired (unregistered, or payload unusable) — ADR-0035 */
  degraded: boolean;
}

const askToRegister = (cwd?: string): string =>
  `This Claude session is not registered with ccs. Ask the user what ROLE and CLUSTER ` +
  `this session should have, then register it: run \`ccs role . <role>\` and (if it belongs ` +
  `to a cluster) \`ccs system . <cluster>\`.` +
  (cwd ? ` (You are running in ${cwd}.)` : "");

export function handleSessionStart(
  db: Database,
  payload: SessionStartPayload,
  now: string,
): SessionStartResult {
  const id = payload?.session_id;
  if (!id) {
    // Malformed / missing id — fail open, do nothing, mark degraded (ADR-0035).
    return { registered: false, additionalContext: null, reArm: null, degraded: true };
  }

  const row = getRow(db, id);

  if (!row || (!row.role && !row.skill && !row.system)) {
    // Unregistered: the hook can't ask the human, so instruct the agent to self-register.
    return {
      registered: false,
      additionalContext: askToRegister(payload.cwd),
      reArm: null,
      degraded: true,
    };
  }

  // Registered → refresh (touch updated_at). Payload-authoritative, no env-var dependency.
  touch(db, id, now);

  // Arming safety net: a resumed loop whose command exists but may not be running.
  let reArm: string | null = null;
  let additionalContext: string | null = null;
  if (payload.source === "resume" && row.resumeCommand) {
    reArm = row.resumeCommand;
    additionalContext =
      `This loop session was resumed. If it is not already running its loop, re-arm it: ` +
      `${row.resumeCommand}`;
  }

  return { registered: true, additionalContext, reArm, degraded: false };
}
