import { readFileSync } from "node:fs";
import { z } from "zod";
import { type Result, err, ok } from "../result.ts";

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "expected kebab-case slug");
const ColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "expected #RRGGBB color");

const CategorySchema = z.object({
  slug: SlugSchema,
  name: z.string().trim().min(1),
  compact_name: z.string().trim().min(1),
  color: ColorSchema,
  aliases: z.array(z.string().trim().min(1)).default([]),
}).strict();

const RegistrySchema = z.object({
  version: z.union([z.string().trim().min(1), z.number().int().nonnegative()]),
  classifier_version: z.string().trim().min(1),
  categories: z.array(CategorySchema).min(1),
  project_mappings: z.record(z.string(), SlugSchema).default({}),
  path_mappings: z.record(z.string(), SlugSchema).default({}),
}).strict();

export interface CategoryDefinition {
  readonly slug: string;
  readonly name: string;
  readonly compactName: string;
  readonly color: string;
  readonly aliases: readonly string[];
}

export interface CategoryRegistry {
  readonly version: string;
  readonly classifierVersion: string;
  readonly categories: readonly CategoryDefinition[];
  readonly projectMappings: Readonly<Record<string, string>>;
  readonly pathMappings: Readonly<Record<string, string>>;
}

export function domainTag(slug: string): string {
  return `domain:${slug}`;
}

export function slugFromDomainTag(tag: string): string | null {
  const match = /^domain:([a-z0-9][a-z0-9-]*)$/.exec(tag.trim());
  return match?.[1] ?? null;
}

export function categoryBySlug(registry: CategoryRegistry, slug: string): CategoryDefinition | null {
  return registry.categories.find((category) => category.slug === slug) ?? null;
}

export function loadCategoryRegistry(path: string): Result<CategoryRegistry> {
  try {
    const parsed = RegistrySchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) {
      return err(new Error(`Invalid category registry at ${path}:\n${z.prettifyError(parsed.error)}`));
    }
    const slugs = new Set<string>();
    const selectors = new Map<string, string>();
    for (const category of parsed.data.categories) {
      if (slugs.has(category.slug)) return err(new Error(`duplicate category slug "${category.slug}"`));
      slugs.add(category.slug);
      for (const value of [category.slug, category.name, category.compact_name, ...category.aliases]) {
        const normalized = value.trim().toLocaleLowerCase();
        const existingSlug = selectors.get(normalized);
        if (existingSlug && existingSlug !== category.slug) {
          return err(new Error(`duplicate category selector "${value}"`));
        }
        selectors.set(normalized, category.slug);
      }
    }
    for (const [kind, mappings] of [
      ["project", parsed.data.project_mappings],
      ["path", parsed.data.path_mappings],
    ] as const) {
      for (const [key, slug] of Object.entries(mappings)) {
        if (!key.trim()) return err(new Error(`${kind} mapping keys must not be empty`));
        if (!slugs.has(slug)) return err(new Error(`${kind} mapping "${key}" references unknown category "${slug}"`));
      }
    }
    return ok({
      version: String(parsed.data.version),
      classifierVersion: parsed.data.classifier_version,
      categories: parsed.data.categories.map((category) => ({
        slug: category.slug,
        name: category.name,
        compactName: category.compact_name,
        color: category.color.toUpperCase(),
        aliases: category.aliases,
      })),
      projectMappings: parsed.data.project_mappings,
      pathMappings: parsed.data.path_mappings,
    });
  } catch (cause) {
    return err(new Error(`Failed to read category registry at ${path}: ${(cause as Error).message}`));
  }
}

export function resolveCategorySelector(registry: CategoryRegistry, selector: string): CategoryDefinition | null {
  const normalized = selector.trim().toLocaleLowerCase();
  return registry.categories.find((category) =>
    [category.slug, category.name, category.compactName, ...category.aliases]
      .some((value) => value.toLocaleLowerCase() === normalized)
  ) ?? null;
}
