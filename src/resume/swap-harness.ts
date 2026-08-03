/**
 * `swap-harness` — relaunch a live session on a DIFFERENT launcher, in place.
 *
 * A harness is a launcher binary: `claudex` (one gateway process reaching both vendors),
 * `claude-native` (real Anthropic, the only one with claude.ai connectors and Remote Control), or
 * `claude-gpt` (the GPT-only gateway wrapper it replaced). Transcripts are stored in Anthropic
 * format regardless of which one wrote them, so any of them can replay another's history — a swap
 * is a launcher change, not a data migration.
 *
 * Now that one launcher reaches both vendors, changing MODEL no longer needs a swap (`/model` does
 * it in-session); what a swap still changes is the CAPABILITY ENVELOPE of the process.
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

/**
 * Where a swap lands, per target harness (Milad, 2026-07-24; `claudex` added 2026-07-28).
 * Deliberately one model per harness rather than a tier map between them: a tier map has to be
 * re-derived every time the fleet changes, and these entries are the ones actually wanted.
 *
 * `claudex` reaches both vendors, so its default is the Claude one it opens on; landing there on a
 * GPT model is a `--model` away and no longer needs a different binary.
 */
export const DEFAULT_SWAP_MODEL: Readonly<Record<string, string>> = {
  claudex: "opus",
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

  // Only refuse a no-op swap when the origin is a FACT, not a guess. `originLauncher` always names
  // the most specific eligible launcher, but once two launchers serve the same model — `claudex`
  // and `claude-native` both replay `claude-opus-5` — the transcript cannot say which binary is
  // running. Refusing an explicit `--to` on the strength of that guess would block exactly the swap
  // the consolidated fleet exists for (claudex → claude-native, to get connectors back), and a
  // wrongly-permitted swap is only ever a restart. This can only fire for an explicit `--to`: the
  // inferred branch above picks a target that is not the origin by construction.
  const certain = originIsCertain(launchers, history);
  if (origin && target.name === origin.name && certain) {
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

  return respawnPlan(proven.value, origin, target, compiled.value, certain);
}

export function describeSwap(plan: RespawnPlan): string {
  return describeRespawn(
    plan,
    `swap ${plan.sessionId.slice(0, 8)} · ${plan.from?.name ?? "(origin unknown)"} → ${plan.to.name}`,
  );
}
