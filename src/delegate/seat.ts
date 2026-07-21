import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { err, ok, type Result } from "../result.ts";

const SeatNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

const FixedRoutingSchema = z.object({
  provider: z.enum(["claude", "gpt"]),
  launcher: z.enum(["claude-native", "claude-gpt"]),
  requested_model: z.string().min(1),
});

const InheritedRoutingSchema = z.object({
  provider: z.literal("inherit_parent"),
  launcher: z.literal("inherit_parent"),
  requested_model: z.string().min(1),
});

const SeatFileSchema = z.object({
  name: SeatNameSchema,
  description: z.string().min(1),
  tools: z.array(z.string().min(1)).default([]),
  effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  permission_mode: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).default([]),
  routing: z.union([FixedRoutingSchema, InheritedRoutingSchema]),
});

export type ProviderFamily = "claude" | "gpt";
export type SeatFile = z.infer<typeof SeatFileSchema>;

export interface SeatDefinition extends SeatFile {
  readonly prompt: string;
  readonly directory: string;
}

export interface ResolvedSeatRoute {
  readonly provider: ProviderFamily;
  readonly launcher: "claude-native" | "claude-gpt";
  readonly requestedModel: string;
  readonly compiledModel: string;
}

export interface CompiledAgentDefinition {
  readonly description: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly model: string;
  readonly permissionMode?: string;
  readonly skills?: readonly string[];
  readonly effort?: "low" | "medium" | "high" | "xhigh";
}

export type CompiledAgents = Readonly<Record<string, CompiledAgentDefinition>>;

function errorMessage(error: object): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeGptModel(model: string): string {
  return model.startsWith("gpt-") && !model.endsWith("[1m]") ? `${model}[1m]` : model;
}

export function inferParentProvider(environment: Readonly<Record<string, string | undefined>>): ProviderFamily {
  const baseUrl = environment.ANTHROPIC_BASE_URL ?? "";
  return /(?:127\.0\.0\.1|localhost):8317/.test(baseUrl) ? "gpt" : "claude";
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
  parentProvider: ProviderFamily,
): Result<ResolvedSeatRoute> {
  const provider = seat.routing.provider === "inherit_parent" ? parentProvider : seat.routing.provider;
  const configured = seat.routing.provider === "inherit_parent"
    ? {
        launcher: parentProvider === "gpt" ? "claude-gpt" as const : "claude-native" as const,
        requested_model: seat.routing.requested_model,
      }
    : {
        launcher: seat.routing.launcher,
        requested_model: seat.routing.requested_model,
      };

  if (provider === "claude" && configured.launcher !== "claude-native") {
    return err(new Error(`Seat ${seat.name} routes Claude through ${configured.launcher}; expected claude-native`));
  }
  if (provider === "gpt" && configured.launcher !== "claude-gpt") {
    return err(new Error(`Seat ${seat.name} routes GPT through ${configured.launcher}; expected claude-gpt`));
  }

  return ok({
    provider,
    launcher: configured.launcher,
    requestedModel: configured.requested_model,
    compiledModel: provider === "gpt" ? normalizeGptModel(configured.requested_model) : configured.requested_model,
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
    ...(seat.effort ? { effort: seat.effort } : {}),
  };
  return { [seat.name]: definition };
}
