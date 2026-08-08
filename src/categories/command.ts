import { loadLocationRegistry } from "../locations/registry.ts";
import { CATEGORY_REGISTRY_PATH, LOCATION_REGISTRY_PATH } from "../paths.ts";
import { categoryAnalyticsCommand } from "./analytics.ts";
import { loadCategoryRegistry, validateCategoryDeployment } from "./registry.ts";

export function categoryCommand(args: readonly string[]): number {
  if (args[0] === "analytics") return categoryAnalyticsCommand(args);
  if (args[0] !== "validate" || args.some((arg) => arg !== "validate" && arg !== "--json")) {
    console.error("usage: ccs category analytics [--json] | validate [--json]");
    return 2;
  }
  const registry = loadCategoryRegistry(CATEGORY_REGISTRY_PATH());
  if (!registry.ok) {
    console.error(`ccs category validate: ${registry.error.message}`);
    return 1;
  }
  const locations = loadLocationRegistry(LOCATION_REGISTRY_PATH());
  const validation = validateCategoryDeployment(registry.value, locations.ok ? locations.value : null);
  if (args.includes("--json")) {
    console.log(JSON.stringify({
      ...validation,
      registryPath: registry.value.sourcePath,
      locationRegistryError: locations.ok ? null : locations.error.message,
    }, null, 2));
  } else {
    for (const diagnostic of validation.diagnostics.filter((item) => !item.exists)) {
      console.log(`missing workspace root: ${diagnostic.slug} ${diagnostic.workspacePath}`);
      console.log(`  active location mappings: ${diagnostic.activeLocationKeys.join(", ") || "none"}`);
      if (!diagnostic.ready) {
        console.log("  rollout blocked: create the workspace root or activate a registered location category mapping");
      }
    }
    if (validation.diagnostics.every((item) => item.exists)) console.log("All category workspace roots exist.");
    if (!locations.ok) console.warn(`ccs category validate: ${locations.error.message}`);
  }
  return validation.ready ? 0 : 1;
}
