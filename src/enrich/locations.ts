import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { runtimeRoot } from "../paths.ts";
import { join } from "node:path";

/**
 * A read-only view of the shared launch-location registry, used to constrain what enrichment may
 * propose as a session's correct working directory.
 *
 * Enrichment asks the model "is this session in the right place, and if not, where does it
 * belong?" Left unconstrained, that produces plausible-looking invented paths. Feeding it the
 * registry turns the answer into a choice from a closed set of curated, verified locations, which
 * can then be checked — the same discipline `src/start/gateway.ts` applies when it refuses a
 * session id the model wasn't given.
 *
 * This module is deliberately narrow and duplicates a little of the richer registry that ships
 * with the `/ccs:new` session router (host eligibility, matching, registration, retirement). It
 * reads the SAME file at the SAME canonical path, so the two agree by construction; when the
 * router lands on master this should collapse into an import from `src/locations/registry.ts`.
 */

export const LOCATION_REGISTRY_PATH = (): string => join(runtimeRoot(), "locations.toml");

/** One curated place work can live, reduced to the fields enrichment actually reasons about. */
export interface EnrichmentLocation {
  readonly key: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly cwd: string;
  readonly kind: string;
}

const RawLocationSchema = z.object({
  key: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  cwd: z.string(),
  kind: z.string(),
  status: z.string().default("active"),
}).passthrough();

const RawRegistrySchema = z.object({
  location: z.array(RawLocationSchema).default([]),
}).passthrough();

/**
 * Load the active locations, or an empty list when there is no registry on this machine.
 *
 * A missing registry is NOT an error. The router that owns this file may not have shipped here
 * yet, and enrichment is still worth running without it — the model simply falls back to
 * proposing a free-text path instead of picking a key. Failing the whole sweep over an absent
 * optional input would be the wrong trade.
 *
 * `passthrough()` on both schemas is intentional: the router owns this file's shape and will add
 * fields (host eligibility, harness defaults) that are none of enrichment's business. Reading it
 * strictly would make every registry extension a breaking change here.
 */
export function loadEnrichmentLocations(path = LOCATION_REGISTRY_PATH()): readonly EnrichmentLocation[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    return [];
  }
  const registry = RawRegistrySchema.safeParse(parsed);
  if (!registry.success) return [];
  return registry.data.location
    .filter((location) => location.status === "active")
    .map((location) => ({
      key: location.key,
      name: location.name,
      aliases: location.aliases,
      cwd: location.cwd,
      kind: location.kind,
    }));
}

/** The set the model's `suggestedLocation` is checked against. */
export function locationKeySet(locations: readonly EnrichmentLocation[]): ReadonlySet<string> {
  return new Set(locations.map((location) => location.key));
}

/**
 * Render the registry for the prompt. Compact on purpose — this rides in every enrichment call, so
 * a verbose format would cost tokens on all ~340 sessions to say the same thing.
 */
export function renderLocationCatalogue(locations: readonly EnrichmentLocation[]): string {
  if (locations.length === 0) return "(no location registry on this machine)";
  return locations
    .map((location) => {
      const aliases = location.aliases.length ? ` — also: ${location.aliases.join(", ")}` : "";
      return `${location.key}\t${location.cwd}\t(${location.kind}) ${location.name}${aliases}`;
    })
    .join("\n");
}
