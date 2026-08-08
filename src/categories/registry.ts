import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { type Result, err, ok } from "../result.ts";

const SlugSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "expected kebab-case slug");
const ColorSchema = z.string().regex(/^#[0-9A-F]{6}$/, "expected #RRGGBB color");
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, "expected semantic version");
const COMPACT_LABEL_MAX = 13;

const CategorySchema = z.object({
  slug: SlugSchema,
  name: z.string().trim().min(1),
  compactLabel: z.string().trim().min(1).max(COMPACT_LABEL_MAX),
  order: z.number().int().positive(),
  todoistColorName: z.string().trim().min(1),
  todoistColor: z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
  hex: ColorSchema,
  scope: z.string().trim().min(1),
  googleLabelName: z.string().trim().min(1),
  workspaceRoot: z.string().regex(/^Workspaces\/[^/]+$/),
}).strict();

const RegistrySchema = z.object({
  $schema: z.literal("./registry.schema.json"),
  version: VersionSchema,
  source: z.literal("Life Domains.md"),
  categories: z.array(CategorySchema).min(1),
}).strict();

export interface CategoryDefinition {
  readonly slug: string;
  readonly name: string;
  readonly compactName: string;
  readonly order: number;
  readonly color: string;
  readonly scope: string;
  readonly workspaceRoot: string;
  readonly workspacePath: string;
}

export interface CategoryRegistry {
  readonly version: string;
  /** Classification rules are versioned by the canonical registry itself. */
  readonly classifierVersion: string;
  readonly sourcePath: string;
  readonly vaultRoot: string;
  readonly categories: readonly CategoryDefinition[];
}

export function domainTag(slug: string): string {
  return `domain:${slug}`;
}

export function slugFromDomainTag(tag: string): string | null {
  const match = /^domain:([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(tag.trim());
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
    const orders = new Set<number>();
    const workspaceRoots = new Set<string>();
    for (const category of parsed.data.categories) {
      if (slugs.has(category.slug)) return err(new Error(`duplicate category slug "${category.slug}"`));
      slugs.add(category.slug);
      if (orders.has(category.order)) return err(new Error(`duplicate category order ${category.order}`));
      orders.add(category.order);
      if (workspaceRoots.has(category.workspaceRoot)) {
        return err(new Error(`duplicate category workspaceRoot "${category.workspaceRoot}"`));
      }
      workspaceRoots.add(category.workspaceRoot);
      for (const value of [category.slug, category.name, category.compactLabel]) {
        const normalized = value.trim().toLocaleLowerCase();
        const existingSlug = selectors.get(normalized);
        if (existingSlug && existingSlug !== category.slug) {
          return err(new Error(`duplicate category selector "${value}"`));
        }
        selectors.set(normalized, category.slug);
      }
    }
    const expectedOrders = parsed.data.categories.map((_, index) => index + 1);
    const actualOrders = parsed.data.categories.map((category) => category.order);
    if (!actualOrders.every((order, index) => order === expectedOrders[index])) {
      return err(new Error(`category order must be canonical and contiguous: ${expectedOrders.join(", ")}`));
    }
    const vaultRoot = resolve(dirname(path), "../..");
    return ok({
      version: parsed.data.version,
      classifierVersion: parsed.data.version,
      sourcePath: path,
      vaultRoot,
      categories: parsed.data.categories.map((category) => ({
        slug: category.slug,
        name: category.name,
        compactName: category.compactLabel,
        order: category.order,
        color: category.hex,
        scope: category.scope,
        workspaceRoot: category.workspaceRoot,
        workspacePath: resolve(vaultRoot, category.workspaceRoot),
      })),
    });
  } catch (cause) {
    return err(new Error(`Failed to read category registry at ${path}: ${(cause as Error).message}`));
  }
}

export function resolveCategorySelector(registry: CategoryRegistry, selector: string): CategoryDefinition | null {
  const normalized = selector.trim().toLocaleLowerCase();
  return registry.categories.find((category) =>
    [category.slug, category.name, category.compactName]
      .some((value) => value.toLocaleLowerCase() === normalized)
  ) ?? null;
}
