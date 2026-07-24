import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { err, ok, type Result } from "../result.ts";

const SeatNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const EffortSchema = z.enum(["low", "medium", "high", "xhigh"]);

const FixedRouteSchema = z.object({
  provider: z.enum(["claude", "gpt"]),
  launcher: z.enum(["claude-native", "claude-gpt"]),
  requested_model: z.string().min(1),
  effort: EffortSchema,
}).strict();

const RoutingSchema = z.object({
  primary: FixedRouteSchema,
  fallback: FixedRouteSchema.optional(),
}).strict();

const SeatFileSchema = z.object({
  name: SeatNameSchema,
  description: z.string().min(1),
  tools: z.array(z.string().min(1)).default([]),
  permission_mode: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).default([]),
  routing: RoutingSchema,
}).strict();

export type ProviderFamily = "claude" | "gpt";
export type SeatEffort = z.infer<typeof EffortSchema>;
export type SeatRouteKind = "primary" | "fallback";
export type SeatRoute = z.infer<typeof FixedRouteSchema>;
export type SeatFile = z.infer<typeof SeatFileSchema>;

export interface SeatDefinition extends SeatFile {
  readonly prompt: string;
  readonly directory: string;
}

export interface ResolvedSeatRoute {
  readonly route: SeatRouteKind;
  readonly provider: ProviderFamily;
  readonly launcher: "claude-native" | "claude-gpt";
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

function errorMessage(error: object): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeGptModel(model: string): string {
  return model.startsWith("gpt-") && !model.endsWith("[1m]") ? `${model}[1m]` : model;
}

export function loadSeat(seatsRoot: string, seatName: string): Result<SeatDefinition> {
  const parsedName = SeatNameSchema.safeParse(seatName);
  if (!parsedName.success) return err(new Error(`Invalid seat name: ${seatName}`));

  const directory = join(seatsRoot, parsedName.data);
  const manifestPath = join(directory, "seat.toml");
  const promptPath = join(directory, "prompt.md");

  try {
    const manifestObject = parseToml(readFileSync(manifestPath, "utf8")) as object;
    const manifest = SeatFileSchema.safeParse(manifestObject);
    if (!manifest.success) {
      return err(new Error(`Invalid seat manifest at ${manifestPath}:\n${z.prettifyError(manifest.error)}`));
    }
    if (manifest.data.name !== parsedName.data) {
      return err(
        new Error(
          `Seat manifest name ${JSON.stringify(manifest.data.name)} does not match directory ${JSON.stringify(parsedName.data)}`,
        ),
      );
    }
    const prompt = readFileSync(promptPath, "utf8").trim();
    if (prompt.length === 0) return err(new Error(`Seat prompt is empty: ${promptPath}`));
    return ok({ ...manifest.data, prompt, directory });
  } catch (error) {
    return err(new Error(`Failed to load seat ${seatName}: ${errorMessage(error as object)}`));
  }
}

export function resolveSeatRoute(
  seat: SeatDefinition,
  routeKind: SeatRouteKind = "primary",
): Result<ResolvedSeatRoute> {
  const route = routeKind === "primary" ? seat.routing.primary : seat.routing.fallback;
  if (!route) return err(new Error(`Seat ${seat.name} does not declare a fallback route`));

  if (route.provider === "claude" && route.launcher !== "claude-native") {
    return err(new Error(`Seat ${seat.name} routes Claude through ${route.launcher}; expected claude-native`));
  }
  if (route.provider === "gpt" && route.launcher !== "claude-gpt") {
    return err(new Error(`Seat ${seat.name} routes GPT through ${route.launcher}; expected claude-gpt`));
  }

  return ok({
    route: routeKind,
    provider: route.provider,
    launcher: route.launcher,
    requestedModel: route.requested_model,
    compiledModel: route.provider === "gpt" ? normalizeGptModel(route.requested_model) : route.requested_model,
    effort: route.effort,
  });
}

export function compileAgent(seat: SeatDefinition, route: ResolvedSeatRoute): CompiledAgents {
  const definition: CompiledAgentDefinition = {
    description: seat.description,
    prompt: seat.prompt,
    model: route.compiledModel,
    ...(seat.tools.length > 0 ? { tools: seat.tools } : {}),
    ...(seat.permission_mode ? { permissionMode: seat.permission_mode } : {}),
    ...(seat.skills.length > 0 ? { skills: seat.skills } : {}),
    effort: route.effort,
  };
  return { [seat.name]: definition };
}
