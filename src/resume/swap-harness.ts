/**
 * `swap-harness` — relaunch a live session on the OTHER launcher, in place.
 *
 * A harness is a launcher binary: `claude-native` (real Anthropic) or `claude-gpt` (the same
 * Claude Code against a local gateway, on GPT models). Transcripts are stored in Anthropic format
 * regardless of which one wrote them, so either can replay the other's history — a swap is a
 * launcher change, not a data migration.
 *
 * The mechanism, identity proofs, and command construction all live in respawn.ts; this module is
 * only the target-and-model decision.
 */
import type { Bridge } from "../cmux/bridge.ts";
import { ok, type Result } from "../result.ts";
import { launcherByName, type Launcher } from "./launchers.ts";
import { compileRoleModelValue } from "./role-model-launch.ts";
import {
  compileRespawnModel,
  describeRespawn,
  originLauncher,
  proveSurface,
  refuse,
  respawnPlan,
  type ModelHistory,
  type RespawnEnv,
  type RespawnPlan,
  type RespawnRefusal,
} from "./respawn.ts";

/**
 * Where a bare swap lands, per target harness (Milad, 2026-07-24). Deliberately one model per
 * harness rather than a tier map between them: a tier map has to be re-derived every time the
 * fleet changes, and these two entries are the ones actually wanted.
 */
export const DEFAULT_SWAP_MODEL: Readonly<Record<string, string>> = {
  "claude-native": "opus",
  "claude-gpt": "gpt-5.6-sol",
};

export function planSwap(
  env: RespawnEnv,
  bridge: Bridge,
  launchers: readonly Launcher[],
  history: ModelHistory,
  opts: {
    readonly to?: string;
    readonly model?: string;
    /**
     * The directory the respawned process must start in — resolved by the caller from the
     * TRANSCRIPT's storage folder, the only directory `--resume` can find this session from.
     */
    readonly resumeCwd?: string;
  } = {},
): Result<RespawnPlan, RespawnRefusal> {
  const proven = proveSurface(env, bridge, opts.resumeCwd);
  if (!proven.ok) return proven;

  const origin = originLauncher(launchers, history);

  let target: Launcher;
  if (opts.to) {
    const named = launcherByName(launchers, opts.to);
    if (!named) {
      const known = launchers.map((l) => l.name).join(", ");
      return refuse("unknown-launcher", `unknown launcher "${opts.to}" — configured: ${known}`);
    }
    target = named;
  } else if (!origin) {
    return refuse(
      "origin-unknown",
      "this session has no model history to infer its current harness from — pass --to to name the target",
    );
  } else {
    // "The other one" is only well defined for a two-launcher fleet. With more, say so instead of
    // picking one and being surprising.
    const others = launchers.filter((l) => l.name !== origin.name);
    if (others.length !== 1) {
      const known = launchers.map((l) => l.name).join(", ");
      return refuse(
        "ambiguous-target",
        `${launchers.length} launchers configured (${known}) — pass --to to name the target`,
      );
    }
    target = others[0]!;
  }

  if (origin && target.name === origin.name) {
    return refuse("same-harness", `already running on ${target.name} — use \`ccs restart\` instead`);
  }

  // A swap always pins a model: the point is to land on a specific backend's model, and the
  // settings alias would resolve to the harness you just left. User overrides are canonical model
  // IDs and always compile through the birth-model contract. The native `opus` default deliberately
  // remains a settings alias; the canonical GPT default compiles to its launcher-only `[1m]` form.
  const requestedModel = opts.model ?? DEFAULT_SWAP_MODEL[target.name];
  if (!requestedModel) {
    return refuse("model-unknown", `no default model for launcher "${target.name}" — pass --model`);
  }
  const shouldCompile = opts.model !== undefined || compileRoleModelValue(requestedModel) !== null;
  const compiled = shouldCompile ? compileRespawnModel(requestedModel, target) : ok(requestedModel);
  if (!compiled.ok) return compiled;

  return ok(respawnPlan(proven.value, origin, target, compiled.value));
}

export function describeSwap(plan: RespawnPlan): string {
  return describeRespawn(
    plan,
    `swap ${plan.sessionId.slice(0, 8)} · ${plan.from?.name ?? "(origin unknown)"} → ${plan.to.name}`,
  );
}
