import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { setParent, setSessionClass } from "../catalogue/db-mutations.ts";
import { openIndex } from "../index/schema.ts";
import { setCategory } from "./assignment.ts";
import { buildCategoryAnalytics } from "./analytics.ts";
import { loadCategoryRegistry } from "./registry.ts";

const roots: string[] = [];
afterEach(() => {
  delete process.env.CCS_CATEGORY_REGISTRY_PATH;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("strategic analytics groups explicit metrics without double-counting displayed roots", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-category-analytics-"));
  roots.push(root);
  const registryPath = join(root, "ClaudeConfig", "categories", "registry.json");
  mkdirSync(join(root, "ClaudeConfig", "categories"), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({
    $schema: "./registry.schema.json", version: "1.0.0", source: "Life Domains.md",
    categories: [{ slug: "events", name: "Events", compactLabel: "Events", order: 1,
      todoistColorName: "Purple", todoistColor: "grape", hex: "#692EC2", scope: "Events", googleLabelName: "Events", workspaceRoot: "Workspaces/Events" }],
  }));
  process.env.CCS_CATEGORY_REGISTRY_PATH = registryPath;
  const registry = loadCategoryRegistry(registryPath);
  if (!registry.ok) throw registry.error;
  const index = openIndex(":memory:");
  const insert = index.query(`INSERT INTO sessions(session_id,host,path,cwd,project_root,project_name,fallback_label,msg_count,file_mtime,file_size,skeleton,resume_id,cost_usd,tok_input,tok_output,tok_cache_read,tok_cache_write,is_subagent) VALUES ($id,'h',$path,'/work','/work','work',$id,$messages,1,1,'',$id,$cost,$input,$output,0,0,$subagent)`);
  insert.run({ $id: "root", $path: "/root", $messages: 10, $cost: 2, $input: 100, $output: 20, $subagent: 0 });
  insert.run({ $id: "aux", $path: "/aux", $messages: 5, $cost: 3, $input: 50, $output: 10, $subagent: 0 });
  insert.run({ $id: "native-subagent", $path: "/sub", $messages: 4, $cost: 4, $input: 40, $output: 8, $subagent: 1 });
  const catalogue = openCatalogue(":memory:", { materialize: false });
  setSessionClass(catalogue, "root", "work_body", "2026-08-07T00:00:00Z");
  setSessionClass(catalogue, "aux", "auxiliary", "2026-08-07T00:00:00Z");
  setParent(catalogue, "aux", "root", "2026-08-07T00:00:00Z");
  setCategory(catalogue, registry.value, { sessionId: "root", auxiliaryPolicy: "reject", slug: "events", source: "manual", classifiedAt: "2026-08-07T00:00:00Z" });
  const result = buildCategoryAnalytics(index, catalogue, "2026-08-07T00:00:00Z");
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]).toMatchObject({ slug: "events", retainedSessions: 1, rootSessions: 1, messages: 10, inputTokens: 100, outputTokens: 20, rootCostUsd: 5 });
  catalogue.close();
  index.close();
});
