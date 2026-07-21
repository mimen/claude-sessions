import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, setParent, setSessionClass } from "./catalogue/db.ts";
import { main } from "./cli.ts";
import { openIndex } from "./index/schema.ts";
import { CATALOGUE_PATH, DB_PATH } from "./paths.ts";

const roots: string[] = [];
const priorRoot = process.env.CCS_ROOT;

afterEach(() => {
  if (priorRoot === undefined) delete process.env.CCS_ROOT;
  else process.env.CCS_ROOT = priorRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seed(): void {
  const root = mkdtempSync(join(tmpdir(), "ccs-cli-aux-"));
  roots.push(root);
  process.env.CCS_ROOT = root;
  mkdirSync(join(root, "cache"), { recursive: true });
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
