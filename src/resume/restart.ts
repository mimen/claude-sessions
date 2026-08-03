/**
 * `restart` — relaunch a live session on the SAME harness, in place.
 *
 * Same primitive as `swap-harness` (see respawn.ts), opposite intent: the launcher does not
 * change, the process does. That buys three things a long-lived session can't get any other way:
 *
 *   - a newly released model. Claude Code resolves an alias like `opus` at STARTUP, so a session
 *     started before Opus 5 shipped stays on the old one for its whole life. This is why a
 *     restart deliberately passes NO `--model`: pinning a concrete id here would defeat the
 *     entire point, leaving you re-resolving to yesterday's model forever.
 *   - a newer Claude Code binary, for the same reason.
 *   - a fresh process, i.e. the RSS of a session that has been running for days.
 *
 * The conversation is untouched — it is the same transcript, resumed.
 */
import type { Bridge } from "../cmux/bridge.ts";
import { ok, type Result } from "../result.ts";
import { launcherByName, type Launcher } from "./launchers.ts";
import {
  compileRespawnModel,
  describeRespawn,
  originIsCertain,
  originLauncher,
  proveSurface,
  refuse,
  respawnPlan,
  type ModelHistory,
  type RespawnEnv,
  type RespawnPlan,
  type RespawnRefusal,
} from "./respawn.ts";

export function planRestart(
  env: RespawnEnv,
  bridge: Bridge,
  launchers: readonly Launcher[],
  history: ModelHistory,
  opts: {
    /** Override the harness to come back on. Normally unset — a restart keeps the current one. */
    readonly on?: string;
    /**
     * Pin a model instead of letting the new process re-resolve from settings. Off by default on
     * purpose; see the module comment.
     */
    readonly model?: string;
    /** Launch directory, resolved by the caller from the transcript's storage folder. */
    readonly resumeCwd?: string;
  } = {},
): Result<RespawnPlan, RespawnRefusal> {
  const proven = proveSurface(env, bridge, opts.resumeCwd);
  if (!proven.ok) return proven;

  const origin = originLauncher(launchers, history);

  let target: Launcher;
  if (opts.on) {
    const named = launcherByName(launchers, opts.on);
    if (!named) {
      const known = launchers.map((l) => l.name).join(", ");
      return refuse("unknown-launcher", `unknown launcher "${opts.on}" — configured: ${known}`);
    }
    target = named;
  } else if (origin) {
    target = origin;
  } else if (launchers.length === 1) {
    // A single-launcher fleet has nothing to be ambiguous about, so a young session can still
    // restart — the common case for `ccs` installs that never configured a gateway.
    target = launchers[0]!;
  } else {
    return refuse(
      "origin-unknown",
      "this session has no model history to infer its current harness from — pass --on to name it",
    );
  }

  // A bare restart aims at the INFERRED origin. When several launchers can replay this history the
  // inference is a preference, not an observation, so the plan says so and the two-phase preflight
  // gives the operator the chance to pin `--on` before anything is replaced.
  const certain = originIsCertain(launchers, history);

  if (!opts.model) return respawnPlan(proven.value, origin, target, null, certain);
  const compiled = compileRespawnModel(opts.model, target);
  if (!compiled.ok) return compiled;
  return respawnPlan(proven.value, origin, target, compiled.value, certain);
}

export function describeRestart(plan: RespawnPlan): string {
  const same = plan.from === null || plan.from.name === plan.to.name;
  const headline = same
    ? `restart ${plan.sessionId.slice(0, 8)} · ${plan.to.name}`
    : `restart ${plan.sessionId.slice(0, 8)} · ${plan.from?.name} → ${plan.to.name} (--on override)`;
  return describeRespawn(plan, headline);
}
