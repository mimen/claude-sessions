/**
 * The SHARED model registry: the one place a model's id, family, context window, launcher
 * membership, label, colour, price and birth eligibility are written.
 *
 * WHY THIS EXISTS. The same nine facts about a model used to be spelled in five hard-coded
 * TypeScript tables here and in ten configuration files outside this repo, and no two of them
 * agreed. Generating TypeScript from the vault would put a landing in front of every model
 * change, so ccs READS the file at runtime instead, exactly as it already reads the launcher and
 * launch-location registries: a curated TOML file in the git-backed vault, reached through a
 * `[routing]` path key, normally by a symlink at `~/.ccs/models.toml`.
 *
 * THE CONTEXT-WINDOW CONTRACT lives in the `[[family]]` rows and is the reason the file is data
 * rather than prose. Claude Code has no per-model context field for a custom model id, so a
 * family declares which of the three available levers accounts for its window:
 *
 *   marker      the id is one Claude Code knows; append the family marker (`[1m]`, or "")
 *   behaves_as  map the row onto a known Claude id; Claude Code adopts THAT model's window
 *   envelope    no mapping; the process-wide `CLAUDE_CODE_MAX_CONTEXT_TOKENS` slot applies
 *
 * A bare Fable/Opus/Sonnet id in a surface Claude Code reads directly short-circuits custom-model
 * handling and silently drops to 200K nominal, and `behavesAs` on a GPT row does the same thing
 * through the mapping. Both are data errors here, which is what lets `ccs doctor models` refuse
 * them instead of a human noticing a 180K effective window months later.
 */
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import { MODEL_REGISTRY_PATH } from "../paths.ts";
import { log } from "../logger.ts";

const PriceSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

const AccountingSchema = z.enum(["marker", "behaves_as", "envelope"]);

const FamilySchema = z.object({
  name: z.string().min(1),
  window: z.number().int().positive(),
  accounting: AccountingSchema,
  /** Required (possibly "") for `marker` accounting; meaningless otherwise. */
  marker: z.string().optional(),
  /** Required for `behaves_as` accounting: the Claude id whose window Claude Code adopts. */
  behaves_as: z.string().min(1).optional(),
  prefixes: z.array(z.string().min(1)).min(1),
});

const ModelSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  provider: z.string().min(1),
  launchers: z.array(z.string().min(1)).default([]),
  label: z.string().min(1),
  short: z.string().min(1),
  description: z.string().min(1).optional(),
  color: z.string().min(1),
  price: PriceSchema.optional(),
  birth: z.boolean().default(false),
  picker: z.boolean().default(false),
  /** A compatibility id: births still resolve, active surfaces name the replacement instead. */
  replaced_by: z.string().min(1).optional(),
  /** Effort suffix every managed birth on this model carries, e.g. `low` for the glue lane. */
  launch_effort: z.string().min(1).optional(),
});

const HistoricalSchema = z.object({
  id: z.string().min(1),
  price: PriceSchema.optional(),
  color: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  short: z.string().min(1).optional(),
  window: z.number().int().positive().optional(),
});

const SlotsSchema = z.object({
  fable: z.string().min(1).optional(),
  opus: z.string().min(1).optional(),
  sonnet: z.string().min(1).optional(),
  haiku: z.string().min(1).optional(),
  subagent: z.string().min(1).optional(),
  max_context: z.number().int().positive().optional(),
  auto_compact: z.number().int().positive().optional(),
});

const DefaultsSchema = z.object({
  enrich_model: z.string().min(1).optional(),
});

const ModelRegistrySchema = z.object({
  version: z.number().int().positive(),
  gateway: z.string().min(1).optional(),
  defaults: DefaultsSchema.default({}),
  family: z.array(FamilySchema).default([]),
  model: z.array(ModelSchema).default([]),
  historical: z.array(HistoricalSchema).default([]),
  slots: z.record(z.string(), SlotsSchema).default({}),
});

export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;
export type ModelFamilyRow = z.infer<typeof FamilySchema>;
export type ModelRow = z.infer<typeof ModelSchema>;
export type HistoricalModelRow = z.infer<typeof HistoricalSchema>;
export type LauncherSlots = z.infer<typeof SlotsSchema>;
export type ModelPrice = z.infer<typeof PriceSchema>;

/** The schema version this build writes and understands. */
export const MODEL_REGISTRY_VERSION = 1;

/** One `/model` row: exactly the shape Claude Code's `modelPicker.options[]` takes. */
export interface PickerRow {
  readonly model: string;
  readonly label: string;
  readonly description?: string;
  readonly behavesAs?: string;
}

/** The tier slots a launcher's environment carries, as Claude Code environment keys. */
export const SLOT_ENVIRONMENT_KEYS = {
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  subagent: "CLAUDE_CODE_SUBAGENT_MODEL",
  max_context: "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  auto_compact: "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
} as const satisfies Readonly<Record<keyof LauncherSlots, string>>;

function validate(registry: ModelRegistry, path: string): Result<ModelRegistry> {
  if (registry.version > MODEL_REGISTRY_VERSION) {
    return err(new Error(
      `model registry at ${path} declares version ${registry.version}, ` +
        `but this ccs understands ${MODEL_REGISTRY_VERSION}; upgrade ccs rather than downgrading the file`,
    ));
  }

  const families = new Map<string, ModelFamilyRow>();
  for (const family of registry.family) {
    if (families.has(family.name)) {
      return err(new Error(`duplicate family "${family.name}" in ${path}`));
    }
    if (family.accounting === "marker" && family.marker === undefined) {
      return err(new Error(`family "${family.name}" in ${path} uses marker accounting without a "marker" (it may be "")`));
    }
    if (family.accounting === "behaves_as" && family.behaves_as === undefined) {
      return err(new Error(`family "${family.name}" in ${path} uses behaves_as accounting without a "behaves_as" donor`));
    }
    if (family.accounting !== "behaves_as" && family.behaves_as !== undefined) {
      return err(new Error(
        `family "${family.name}" in ${path} sets behaves_as under "${family.accounting}" accounting; ` +
          "a behavesAs mapping drops the row to the donor's window",
      ));
    }
    families.set(family.name, family);
  }

  const ids = new Set<string>();
  for (const model of registry.model) {
    if (ids.has(model.id)) return err(new Error(`duplicate model id "${model.id}" in ${path}`));
    ids.add(model.id);
    const family = families.get(model.family);
    if (!family) {
      return err(new Error(`model "${model.id}" in ${path} names unknown family "${model.family}"`));
    }
    if (!family.prefixes.some((prefix) => model.id.startsWith(prefix))) {
      return err(new Error(
        `model "${model.id}" in ${path} matches none of family "${family.name}" prefixes: ${family.prefixes.join(", ")}`,
      ));
    }
  }
  for (const row of registry.historical) {
    if (ids.has(row.id)) return err(new Error(`duplicate model id "${row.id}" in ${path}`));
    ids.add(row.id);
  }

  for (const model of registry.model) {
    if (model.replaced_by === undefined) continue;
    const replacement = registry.model.find((candidate) => candidate.id === model.replaced_by);
    if (!replacement) {
      return err(new Error(`model "${model.id}" in ${path} is replaced_by unknown model "${model.replaced_by}"`));
    }
    if (replacement.replaced_by !== undefined) {
      return err(new Error(`model "${model.id}" in ${path} is replaced_by "${model.replaced_by}", which is itself replaced`));
    }
  }

  return ok(registry);
}

/**
 * Load the registry. Unlike the launcher fleet, a MISSING file is an error: every birth, price and
 * badge reads this file, and a silent empty fleet would refuse every model rather than degrade.
 */
export function loadModelRegistry(path: string): Result<ModelRegistry> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`failed to read model registry at ${path}: ${detail}`));
  }

  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`invalid TOML in model registry at ${path}: ${detail}`));
  }

  const parsed = ModelRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    return err(new Error(`invalid model registry at ${path}:\n${z.prettifyError(parsed.error)}`));
  }
  return validate(parsed.data, path);
}

/** The configured registry path: an explicit override, else the CCS runtime default. */
export function modelRegistryPath(): string {
  return process.env.CCS_MODEL_REGISTRY_PATH ?? MODEL_REGISTRY_PATH();
}

let memoized: Result<ModelRegistry> | null = null;

/**
 * The process-wide registry, loaded once. Display paths take this and degrade on failure; launch
 * paths take `requireModelRegistry` and fail loudly, because compiling a birth against a guessed
 * fleet is how a session lands on the wrong subscription.
 */
export function modelRegistry(): Result<ModelRegistry> {
  memoized ??= loadModelRegistry(modelRegistryPath());
  return memoized;
}

export function requireModelRegistry(): ModelRegistry {
  const loaded = modelRegistry();
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

let warnedUnreadable = false;

/**
 * The registry for a DISPLAY path: prices, colours, badges. Null when the file cannot be read,
 * so a TUI listing renders unpriced rows instead of refusing to open. Warned once per process,
 * because the alternative is one stderr line per session in a list of four hundred.
 */
export function displayModelRegistry(): ModelRegistry | null {
  const loaded = modelRegistry();
  if (loaded.ok) return loaded.value;
  if (!warnedUnreadable) {
    warnedUnreadable = true;
    log.warn("model registry unreadable; sessions render unpriced", {
      path: modelRegistryPath(),
      error: loaded.error.message,
    });
  }
  return null;
}

export function activeModels(registry: ModelRegistry): readonly ModelRow[] {
  return registry.model;
}

export function historicalModels(registry: ModelRegistry): readonly HistoricalModelRow[] {
  return registry.historical;
}

export function modelById(registry: ModelRegistry, id: string): ModelRow | null {
  return registry.model.find((model) => model.id === id) ?? null;
}

/** Remove Claude Code's launcher-only context declaration from a model ID. */
export function canonicalModelId(model: string): string {
  return model.replace(/(?:\[1m\])+$/, "");
}

/** The model id without its caller-side effort suffix, which is not part of any id. */
export function modelBase(model: string): string {
  const canonical = canonicalModelId(model);
  const open = canonical.indexOf("(");
  return open === -1 ? canonical : canonical.slice(0, open);
}

/** The family a model id belongs to, by longest declared prefix. Free-form ids may have none. */
export function familyOf(registry: ModelRegistry, model: string): ModelFamilyRow | null {
  const base = modelBase(model);
  const row = modelById(registry, base);
  if (row) return registry.family.find((family) => family.name === row.family) ?? null;
  let best: ModelFamilyRow | null = null;
  let bestLength = -1;
  for (const family of registry.family) {
    for (const prefix of family.prefixes) {
      if (base.startsWith(prefix) && prefix.length > bestLength) {
        best = family;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * Which launchers apply their family's marker.
 *
 * A launcher earns a `[slots.<name>]` table precisely when it declares Claude Code's context
 * environment, and a marker is the per-model half of that same declaration. `claude-native` has no
 * table because it clears every override and lets Claude Code's own defaults stand, so a marker
 * there would be a client-side claim the process environment does not back.
 */
export function isMarkerLauncher(registry: ModelRegistry, launcher: string): boolean {
  return Object.hasOwn(registry.slots, launcher);
}

/** The launcher names the registry knows: every launcher a row or a slot table names. */
export function launcherNames(registry: ModelRegistry): readonly string[] {
  const names: string[] = [];
  for (const model of registry.model) {
    for (const launcher of model.launchers) if (!names.includes(launcher)) names.push(launcher);
  }
  for (const launcher of Object.keys(registry.slots)) {
    if (!names.includes(launcher)) names.push(launcher);
  }
  return names;
}

/**
 * The spelling Claude Code must see for a model on one launcher: the canonical id plus its
 * family's marker, with any caller-side effort suffix left exactly where the wrapper leaves it.
 */
export function claudeCodeDeclaration(
  registry: ModelRegistry,
  model: string,
  launcher: string,
): string {
  const canonical = canonicalModelId(model);
  if (!isMarkerLauncher(registry, launcher)) return canonical;
  const family = familyOf(registry, canonical);
  if (!family || family.accounting !== "marker") return canonical;
  return `${canonical}${family.marker ?? ""}`;
}

function hostedBy(model: ModelRow, launcher: string): boolean {
  return model.launchers.includes(launcher);
}

/**
 * The `/model` rows a launcher offers.
 *
 * `behavesAs` rides only on a `behaves_as` family. On an `envelope` family it is the 200K
 * regression this registry exists to prevent: Claude Code adopts the donor's window and stops
 * honouring the launcher's `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.
 */
export function pickerRows(registry: ModelRegistry, launcher: string): readonly PickerRow[] {
  const rows: PickerRow[] = [];
  for (const model of registry.model) {
    if (!model.picker || !hostedBy(model, launcher)) continue;
    const family = familyOf(registry, model.id);
    const behavesAs = family?.accounting === "behaves_as" ? family.behaves_as : undefined;
    rows.push({
      model: claudeCodeDeclaration(registry, model.id, launcher),
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
      ...(behavesAs ? { behavesAs } : {}),
    });
  }
  return rows;
}

/** Every active model a launcher hosts, picker row or not, in the spelling Claude Code accepts. */
export function allowlist(registry: ModelRegistry, launcher: string): readonly string[] {
  return registry.model
    .filter((model) => hostedBy(model, launcher))
    .map((model) => claudeCodeDeclaration(registry, model.id, launcher));
}

interface PrefixRow {
  readonly id: string;
  readonly price?: ModelPrice;
  readonly color?: string;
  readonly label?: string;
  readonly short?: string;
}

function prefixRows(registry: ModelRegistry): readonly PrefixRow[] {
  return [...registry.model, ...registry.historical];
}

/** Exact id first, then the longest id-prefix among rows that carry the attribute at all. */
function resolveByPrefix<T>(
  registry: ModelRegistry,
  model: string,
  pick: (row: PrefixRow) => T | undefined,
): T | null {
  const base = modelBase(model);
  const rows = prefixRows(registry);
  const exact = rows.find((row) => row.id === base);
  const exactValue = exact ? pick(exact) : undefined;
  if (exactValue !== undefined) return exactValue;
  let best: T | null = null;
  let bestLength = -1;
  for (const row of rows) {
    const value = pick(row);
    if (value === undefined) continue;
    if (base.startsWith(row.id) && row.id.length > bestLength) {
      best = value;
      bestLength = row.id.length;
    }
  }
  return best;
}

// Sonnet 5 bills $2/$10 introductory through 2026-08-31, $3/$15 after. A date rule is not
// availability data, so it stays in code while the post-intro price stays in the registry.
const SONNET5_INTRO_END = Date.parse("2026-09-01T00:00:00Z");
const SONNET5_INTRO_PRICE: ModelPrice = { input: 2, output: 10 };

export function priceFor(
  registry: ModelRegistry,
  model: string,
  timestamp?: string,
): ModelPrice | null {
  if (modelBase(model).startsWith("claude-sonnet-5")) {
    const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
    if (!Number.isNaN(parsed) && parsed < SONNET5_INTRO_END) return SONNET5_INTRO_PRICE;
  }
  return resolveByPrefix(registry, model, (row) => row.price);
}

export function colorOf(registry: ModelRegistry, model: string): string | null {
  return resolveByPrefix(registry, model, (row) => row.color);
}

export function labelOf(registry: ModelRegistry, model: string): string | null {
  return resolveByPrefix(registry, model, (row) => row.label);
}

export function shortOf(registry: ModelRegistry, model: string): string | null {
  return resolveByPrefix(registry, model, (row) => row.short);
}

/** Canonical ids CCS accepts for a fresh managed birth, compatibility rows included. */
export function birthModelIds(registry: ModelRegistry): readonly string[] {
  return registry.model.filter((model) => model.birth).map((model) => model.id);
}

/** Compatibility id → the active declaration that should be written in its place. */
export function activeDeclarationReplacements(registry: ModelRegistry): ReadonlyMap<string, string> {
  const replacements = new Map<string, string>();
  for (const model of registry.model) {
    if (model.replaced_by !== undefined) replacements.set(model.id, model.replaced_by);
  }
  return replacements;
}

export function slots(registry: ModelRegistry, launcher: string): LauncherSlots | null {
  return registry.slots[launcher] ?? null;
}

/** The model enrichment runs on when no caller names one. */
export function enrichModel(registry: ModelRegistry): string | null {
  return registry.defaults.enrich_model ?? null;
}
