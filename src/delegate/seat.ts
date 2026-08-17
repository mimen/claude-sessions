/**
 * A SEAT's definition is one native Claude Code agent definition: `<agents-root>/<seat>.md`,
 * YAML frontmatter plus the role prompt below it. There is no second representation.
 *
 * Claude Code ignores frontmatter keys it does not recognise, so the delegate-only keys
 * (`fallback_model`, `fallback_effort`) ride along in the very file the native Agent tool
 * auto-discovers. One file is therefore both the native agent and the ccs seat, which is what
 * retired the parallel `seat.toml` + `prompt.md` registry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import { ONE_MILLION_MARKER_LAUNCHERS } from "../resume/role-model-launch.ts";
import type { LauncherName, ModelFamily } from "../resume/role-model-launch.ts";

const SeatNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const EffortSchema = z.enum(["low", "medium", "high", "xhigh"]);

/** `tools:`/`skills:` are authorable as a YAML list or as Claude Code's comma-separated string. */
const NameListSchema = z.preprocess(
  (value) => (typeof value === "string"
    ? value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : value),
  z.array(z.string().min(1)),
);

/**
 * The keys `ccs delegate` reads. Deliberately NOT `.strict()`: an agent definition carries whatever
 * else its author or a future Claude Code version wants, and an unknown key must be ignored rather
 * than refuse the launch — tolerating them in both directions is the premise of the single file.
 */
const AgentDefinitionSchema = z.object({
  name: SeatNameSchema,
  description: z.string().min(1),
  // Present but empty keeps the retired manifest's meaning: declare no restriction, inherit every
  // tool. `tools` is omitted from the compiled agent in that case, which is how Claude Code spells it.
  tools: NameListSchema,
  model: z.string().min(1),
  effort: EffortSchema,
  fallback_model: z.string().min(1).optional(),
  fallback_effort: EffortSchema.optional(),
  skills: NameListSchema.optional(),
  permission_mode: z.string().min(1).optional(),
});

export type SeatEffort = z.infer<typeof EffortSchema>;
export type SeatRouteKind = "primary" | "fallback";

/**
 * The launcher every delegated child is born on.
 *
 * An agent definition declares a MODEL and never a launcher, so the launcher stopped being a
 * per-seat authoring decision — and with it the provider/launcher pairing invariant the old
 * manifest had to validate. `claudex` is the birth route default and the one launcher in the fleet
 * whose process envelope safely reaches the Claude 1M and GPT-5.6 921K families, which is precisely
 * what lets one definition name either provider's model.
 */
export const DELEGATE_LAUNCHER: LauncherName = "claudex";

export interface SeatFallbackRoute {
  readonly model: string;
  readonly effort: SeatEffort;
}

export interface SeatDefinition {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly model: string;
  readonly effort: SeatEffort;
  /** null when the definition declares no manual backup; `--fallback` then fails before reservation. */
  readonly fallback: SeatFallbackRoute | null;
  readonly skills: readonly string[];
  readonly permissionMode: string | null;
  readonly prompt: string;
  readonly path: string;
}

export interface ResolvedSeatRoute {
  readonly route: SeatRouteKind;
  readonly provider: ModelFamily;
  readonly launcher: LauncherName;
  readonly requestedModel: string;
  readonly compiledModel: string;
  readonly effort: SeatEffort;
}

export interface CompiledAgentDefinition {
  readonly description: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly model: string;
  readonly permissionMode?: string;
  readonly skills?: readonly string[];
  readonly effort: SeatEffort;
}

export type CompiledAgents = Readonly<Record<string, CompiledAgentDefinition>>;

interface AgentDocument {
  readonly frontmatter: string;
  readonly body: string;
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

function splitAgentDocument(text: string): AgentDocument | null {
  const match = FRONTMATTER.exec(text);
  return match ? { frontmatter: match[1] ?? "", body: match[2] ?? "" } : null;
}

function errorMessage(error: object): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The vendor a seat's model belongs to, read off its canonical prefix. Recorded for provenance
 * only — nothing routes on it now that one launcher serves both vendors. Deliberately not
 * `modelFamily`, which classifies the closed birth-model vocabulary: a seat's model is a free-form
 * authored string so the registry can name a model this binary has never heard of.
 */
function providerFor(model: string): ModelFamily {
  if (model.startsWith("gpt-")) return "gpt";
  if (model.startsWith("qwen")) return "local";
  return "claude";
}

/**
 * Compile a seat model for its process envelope. Claude Code strips `[1m]` client-side, so Claude
 * models routed through `claudex` need it to declare their real 1M window. GPT-5.6 uses the
 * launcher's exact 921K environment and must not carry a false 1M declaration.
 */
export function compileLaunchModel(model: string, launcher: LauncherName): string {
  const canonical = model.endsWith("[1m]") ? model.slice(0, -4) : model;
  if (canonical.startsWith("claude-") && ONE_MILLION_MARKER_LAUNCHERS.has(launcher)) {
    return `${canonical}[1m]`;
  }
  return canonical;
}

export function loadSeat(agentsRoot: string, seatName: string): Result<SeatDefinition> {
  const parsedName = SeatNameSchema.safeParse(seatName);
  if (!parsedName.success) return err(new Error(`Invalid seat name: ${seatName}`));

  const path = join(agentsRoot, `${parsedName.data}.md`);
  try {
    const document = splitAgentDocument(readFileSync(path, "utf8"));
    if (!document) return err(new Error(`Agent definition has no YAML frontmatter: ${path}`));

    const parsed = AgentDefinitionSchema.safeParse(Bun.YAML.parse(document.frontmatter) as object);
    if (!parsed.success) {
      return err(new Error(`Invalid agent definition at ${path}:\n${z.prettifyError(parsed.error)}`));
    }
    const definition = parsed.data;
    if (definition.name !== parsedName.data) {
      return err(
        new Error(
          `Agent definition name ${JSON.stringify(definition.name)} does not match file ${JSON.stringify(`${parsedName.data}.md`)}`,
        ),
      );
    }
    // Half a fallback is an authoring mistake, not a route: refuse it here rather than launch the
    // primary model at the backup's effort the first time somebody passes --fallback.
    if (Boolean(definition.fallback_model) !== Boolean(definition.fallback_effort)) {
      return err(
        new Error(`Agent definition ${path} must declare fallback_model and fallback_effort together, or neither`),
      );
    }
    const prompt = document.body.trim();
    if (prompt.length === 0) return err(new Error(`Agent definition has an empty role prompt: ${path}`));

    return ok({
      name: definition.name,
      description: definition.description,
      tools: definition.tools,
      model: definition.model,
      effort: definition.effort,
      fallback: definition.fallback_model && definition.fallback_effort
        ? { model: definition.fallback_model, effort: definition.fallback_effort }
        : null,
      skills: definition.skills ?? [],
      permissionMode: definition.permission_mode ?? null,
      prompt,
      path,
    });
  } catch (error) {
    return err(new Error(`Failed to load seat ${seatName}: ${errorMessage(error as object)}`));
  }
}

export function resolveSeatRoute(
  seat: SeatDefinition,
  routeKind: SeatRouteKind = "primary",
): Result<ResolvedSeatRoute> {
  const route = routeKind === "primary" ? { model: seat.model, effort: seat.effort } : seat.fallback;
  if (!route) return err(new Error(`Seat ${seat.name} does not declare a fallback route`));

  return ok({
    route: routeKind,
    provider: providerFor(route.model),
    launcher: DELEGATE_LAUNCHER,
    requestedModel: route.model,
    compiledModel: compileLaunchModel(route.model, DELEGATE_LAUNCHER),
    effort: route.effort,
  });
}

export function compileAgent(seat: SeatDefinition, route: ResolvedSeatRoute): CompiledAgents {
  const definition: CompiledAgentDefinition = {
    description: seat.description,
    prompt: seat.prompt,
    model: route.compiledModel,
    ...(seat.tools.length > 0 ? { tools: seat.tools } : {}),
    ...(seat.permissionMode ? { permissionMode: seat.permissionMode } : {}),
    ...(seat.skills.length > 0 ? { skills: seat.skills } : {}),
    effort: route.effort,
  };
  return { [seat.name]: definition };
}
