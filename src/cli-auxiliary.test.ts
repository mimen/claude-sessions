import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "./catalogue/db-schema.ts";
import { setParent, setSessionClass } from "./catalogue/db-mutations.ts";
import { main } from "./cli.ts";
import { openIndex } from "./index/schema.ts";
import { CATALOGUE_PATH, DB_PATH } from "./paths.ts";
import { setCategory } from "./categories/assignment.ts";
import type { CategoryRegistry } from "./categories/registry.ts";

const CATEGORY_REGISTRY: CategoryRegistry = {
  version: "1.0.0",
  classifierVersion: "1.0.0",
  sourcePath: "/vault/ClaudeConfig/categories/registry.json",
  vaultRoot: "/vault",
  categories: [{ slug: "ai-systems", name: "AI Systems", compactName: "AI", order: 1, color: "#2A67E2", scope: "AI", workspaceRoot: "Workspaces/Assistant", workspacePath: "/vault/Workspaces/Assistant" }],
};

const roots: string[] = [];
const priorRoot = process.env.CCS_ROOT;
const priorCategoryRegistry = process.env.CCS_CATEGORY_REGISTRY_PATH;

afterEach(() => {
  if (priorRoot === undefined) delete process.env.CCS_ROOT;
  else process.env.CCS_ROOT = priorRoot;
  if (priorCategoryRegistry === undefined) delete process.env.CCS_CATEGORY_REGISTRY_PATH;
  else process.env.CCS_CATEGORY_REGISTRY_PATH = priorCategoryRegistry;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seed(): void {
  const root = mkdtempSync(join(tmpdir(), "ccs-cli-aux-"));
  roots.push(root);
  process.env.CCS_ROOT = root;
  mkdirSync(join(root, "cache"), { recursive: true });
  const registryPath = join(root, "ClaudeConfig", "categories", "registry.json");
  mkdirSync(join(root, "ClaudeConfig", "categories"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({
    $schema: "./registry.schema.json", version: "1.0.0", source: "Life Domains.md",
    categories: [{ slug: "ai-systems", name: "AI Systems", compactLabel: "AI", order: 1,
      todoistColorName: "Blue", todoistColor: "blue", hex: "#2A67E2", scope: "AI", googleLabelName: "AI", workspaceRoot: "Workspaces/Assistant" }],
  }));
  process.env.CCS_CATEGORY_REGISTRY_PATH = registryPath;
  const index = openIndex(DB_PATH());
  const insert = index.query(
    `INSERT INTO sessions (
      session_id, host, path, cwd, project_root, project_name, branch, version,
      first_ts, last_ts, msg_count, file_mtime, file_size,
      native_title, fallback_label, skeleton, is_subagent, parent_session_id, resume_id,
      cost_usd, cost_by_model
    ) VALUES ($id,'h',$path,'/repo','/repo','repo',NULL,'1',
      '2026-07-20T00:00:00Z','2026-07-20T00:01:00Z',1,1,1,
      $title,$title,'',0,NULL,$id,$cost,$models)`,
  );
  insert.run({ $id: "parent", $path: "/parent", $title: "Parent Session", $cost: 2, $models: '{"claude-fable-5":2}' });
  insert.run({ $id: "child", $path: "/child", $title: "Auxiliary Child", $cost: 3, $models: '{"gpt-5.6-sol":3}' });
  index.close();

  const catalogue = openCatalogue(CATALOGUE_PATH());
  setSessionClass(catalogue, "parent", "work_body", "2026-07-20T00:00:00Z");
  setSessionClass(catalogue, "child", "auxiliary", "2026-07-20T00:00:00Z");
  setParent(catalogue, "child", "parent", "2026-07-20T00:00:00Z");
  setCategory(catalogue, CATEGORY_REGISTRY, {
    sessionId: "parent",
    auxiliaryPolicy: "reject",
    slug: "ai-systems",
    source: "manual",
    manualLock: true,
    classifiedAt: "2026-07-20T00:00:00Z",
  });
  catalogue.close();
}

async function outputFor(args: readonly string[]): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...values: object[]) => {
    lines.push(values.map(String).join(" "));
  });
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await main(["bun", "ccs", ...args])).toBe(0);
    return lines.join("\n");
  } finally {
    error.mockRestore();
    log.mockRestore();
  }
}

describe("CLI auxiliary visibility", () => {
  test("ls hides auxiliary rows but includes their recursive cost", async () => {
    seed();
    const hidden = await outputFor(["ls"]);
    expect(hidden).toContain("Parent Session");
    expect(hidden).not.toContain("Auxiliary Child");
    expect(hidden).toContain("$5.00");

    const revealed = await outputFor(["ls", "--auxiliary"]);
    expect(revealed).toContain("Auxiliary Child");
    expect(revealed).toContain("AUX");
  });

  test("ls exposes effective category, filters by it, and reports category spend", async () => {
    seed();
    const filtered = await outputFor(["ls", "--category", "ai-systems"]);
    expect(filtered).toContain("domain:ai-systems");
    expect(filtered).toContain("$5.00 displayed-root spend");
    expect(filtered).toContain("Parent Session");

    const inherited = await outputFor(["ls", "--category", "ai-systems", "--auxiliary"]);
    expect(inherited).toContain("Auxiliary Child");
    expect(inherited.match(/domain:ai-systems/g)).toHaveLength(2);

    const empty = await outputFor(["ls", "--category", "events"]);
    expect(empty).not.toContain("Parent Session");
    expect(empty).toContain("0 sessions");
  });

  test("ls labels effective slugs absent from the registry as invalid", async () => {
    seed();
    const catalogue = openCatalogue(CATALOGUE_PATH());
    catalogue.query("UPDATE session_category_assignments SET slug='removed' WHERE session_id='parent'").run();
    catalogue.query("UPDATE session_tags SET entity='domain:removed' WHERE session_id='parent'").run();
    catalogue.close();
    const output = await outputFor(["ls"]);
    expect(output).toContain("invalid:domain:removed");
    expect(output).not.toMatch(/\sdomain:removed\s/);
  });

  test("explicit tag removal can clear a locked slug removed from the registry", async () => {
    seed();
    const catalogue = openCatalogue(CATALOGUE_PATH());
    catalogue.query("UPDATE session_category_assignments SET slug='removed', classifier_version='0.9.0' WHERE session_id='parent'").run();
    catalogue.query("UPDATE session_tags SET entity='domain:removed' WHERE session_id='parent' AND entity='domain:ai-systems'").run();
    catalogue.close();
    expect(await outputFor(["tag", "parent", "domain:removed", "--remove"])).toContain("untagged domain:removed");
    const check = openCatalogue(CATALOGUE_PATH());
    expect(check.query("SELECT * FROM session_category_assignments WHERE session_id='parent'").get()).toBeNull();
    check.close();
  });

  test("tree keeps the parent and total while hiding auxiliary descendants", async () => {
    seed();
    const hidden = await outputFor(["tree"]);
    expect(hidden).toContain("Parent Session");
    expect(hidden).not.toContain("Auxiliary Child");
    expect(hidden).toContain("$2.00 self · $5.00 total");
    expect(hidden).toContain("Claude $2.00");
    expect(hidden).toContain("GPT $3.00");

    const revealed = await outputFor(["tree", "--auxiliary"]);
    expect(revealed).toContain("Auxiliary Child");
    expect(revealed).toContain("AUX");
  });
});
