import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "./db-schema.ts";
import { getRow } from "./db-queries.ts";
import { setParent, setSessionClass, setCustomTitle } from "./db-mutations.ts";
import { openIndex } from "../index/schema.ts";
import { CATALOGUE_PATH, DB_PATH } from "../paths.ts";
import {
  buildManifest,
  executeDestroy,
  markIncognito,
  resolveSubtree,
  type DestroyEnvironment,
} from "./destroy.ts";

const AT = "2026-08-09T00:00:00Z";
const roots: string[] = [];
const priorRoot = process.env.CCS_ROOT;

afterEach(() => {
  if (priorRoot === undefined) delete process.env.CCS_ROOT;
  else process.env.CCS_ROOT = priorRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly store: string;
  readonly env: DestroyEnvironment;
  /** Every path the fixture created, whether or not destroy is expected to remove it. */
  readonly paths: Record<string, string>;
}

/**
 * A store with a parent, one auxiliary child, and one unrelated session, plus every sidecar
 * shape footprintOf() knows how to find. The unrelated session is the control: a destroy that
 * over-reaches shows up as its disappearance, which a same-subtree-only fixture would miss.
 */
function seed(opts: { readonly liveSessionIds?: readonly string[]; readonly closeSucceeds?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ccs-destroy-"));
  roots.push(root);
  process.env.CCS_ROOT = root;
  mkdirSync(join(root, "cache"), { recursive: true });

  const store = join(root, "projects", "-repo");
  const tasks = join(root, "tasks");
  const claudeHome = join(root, "claude-home");
  mkdirSync(store, { recursive: true });

  const paths: Record<string, string> = {
    parentTranscript: join(store, "parent.jsonl"),
    parentShadow: join(root, "projects", "-other", "parent.jsonl"),
    childTranscript: join(store, "child.jsonl"),
    otherTranscript: join(store, "other.jsonl"),
    sidechains: join(store, "parent"),
    tasksDir: join(tasks, "parent"),
    fileHistory: join(claudeHome, "file-history", "parent"),
    sessionEnv: join(claudeHome, "session-env", "parent"),
    enrichLog: join(root, "enrich", "parent.log"),
    selfCheckLog: join(root, "self-check", "parent.log"),
  };
  mkdirSync(join(root, "projects", "-other"), { recursive: true });
  for (const key of ["parentTranscript", "parentShadow", "childTranscript", "otherTranscript"]) {
    writeFileSync(paths[key]!, "{}\n");
  }
  for (const key of ["sidechains", "tasksDir", "fileHistory", "sessionEnv"]) {
    mkdirSync(paths[key]!, { recursive: true });
    writeFileSync(join(paths[key]!, "inside.json"), "{}");
  }
  for (const key of ["enrichLog", "selfCheckLog"]) {
    mkdirSync(join(paths[key]!, ".."), { recursive: true });
    writeFileSync(paths[key]!, "log\n");
  }

  const index = openIndex(DB_PATH());
  const insert = index.query(
    `INSERT INTO sessions (
      session_id, host, path, cwd, project_root, project_name, branch, version,
      first_ts, last_ts, msg_count, file_mtime, file_size,
      native_title, fallback_label, skeleton, is_subagent, parent_session_id, resume_id,
      cost_usd, cost_by_model
    ) VALUES ($id,'h',$path,'/repo','/repo','repo',NULL,'1',
      $at,$at,1,1,1,$title,$title,'',0,NULL,$id,0,'{}')`,
  );
  insert.run({ $id: "parent", $path: paths.parentTranscript!, $title: "Parent", $at: AT });
  insert.run({ $id: "child", $path: paths.childTranscript!, $title: "Child", $at: AT });
  insert.run({ $id: "other", $path: paths.otherTranscript!, $title: "Other", $at: AT });
  index.query("INSERT INTO sessions_fts (session_id, title, skeleton) VALUES ('parent','Parent','secret')").run();
  index.query("INSERT INTO sessions_fts (session_id, title, skeleton) VALUES ('other','Other','kept')").run();
  index.query("UPDATE sessions SET shadow_paths = $s WHERE session_id = 'parent'")
    .run({ $s: JSON.stringify([paths.parentShadow]) });
  index.close();

  const catalogue = openCatalogue(CATALOGUE_PATH());
  setSessionClass(catalogue, "parent", "work_body", AT);
  setSessionClass(catalogue, "child", "auxiliary", AT);
  setParent(catalogue, "child", "parent", AT);
  setCustomTitle(catalogue, "other", "Unrelated", AT);
  catalogue.close();

  const live = new Set(opts.liveSessionIds ?? []);
  return {
    root,
    store,
    paths,
    env: {
      store,
      tasks,
      ccsRoot: root,
      claudeHome,
      liveSessionIds: async () => live,
      closeSession: async (sessionId) => {
        if (opts.closeSucceeds === false) return false;
        live.delete(sessionId);
        return true;
      },
    },
  };
}

test("resolveSubtree: parent first, descendants after, and a parent cycle terminates", () => {
  const fixture = seed();
  const catalogue = openCatalogue(CATALOGUE_PATH());
  try {
    expect(resolveSubtree(catalogue, "parent")).toEqual(["parent", "child"]);
    expect(resolveSubtree(catalogue, "other")).toEqual(["other"]);
    // Nothing in the schema prevents a cycle, so the walk has to survive one.
    setParent(catalogue, "parent", "child", AT);
    expect(resolveSubtree(catalogue, "parent").sort()).toEqual(["child", "parent"]);
  } finally {
    catalogue.close();
  }
  expect(existsSync(fixture.paths.parentTranscript!)).toBe(true);
});

test("destroy erases the whole subtree from disk, catalogue, index, and FTS", async () => {
  const fixture = seed();
  const catalogue = openCatalogue(CATALOGUE_PATH());
  const index = openIndex(DB_PATH());
  try {
    const manifest = await buildManifest(catalogue, index, "parent", fixture.env);
    const outcome = await executeDestroy(catalogue, index, manifest, fixture.env, AT);
    expect(outcome.ok).toBe(true);

    // Disk: every shape footprintOf collects, including the shadow transcript left behind by a
    // session that moved worktrees -- the copy a cwd-derived path would have missed.
    for (const key of Object.keys(fixture.paths)) {
      if (key === "otherTranscript") continue;
      expect(existsSync(fixture.paths[key]!)).toBe(false);
    }
    expect(existsSync(fixture.paths.otherTranscript!)).toBe(true);

    // Catalogue and index, including the FTS row -- a search hit would otherwise resurrect the
    // session's text between reindexes.
    expect(getRow(catalogue, "parent")).toBeNull();
    expect(getRow(catalogue, "child")).toBeNull();
    expect(getRow(catalogue, "other")).not.toBeNull();
    const remaining = index.query("SELECT session_id FROM sessions ORDER BY session_id").all() as { session_id: string }[];
    expect(remaining.map((r) => r.session_id)).toEqual(["other"]);
    const fts = index.query("SELECT session_id FROM sessions_fts").all() as { session_id: string }[];
    expect(fts.map((r) => r.session_id)).toEqual(["other"]);
  } finally {
    index.close();
    catalogue.close();
  }
});

test("destroy aborts before deleting anything when a live workspace will not close", async () => {
  const fixture = seed({ liveSessionIds: ["parent"], closeSucceeds: false });
  const catalogue = openCatalogue(CATALOGUE_PATH());
  const index = openIndex(DB_PATH());
  try {
    const manifest = await buildManifest(catalogue, index, "parent", fixture.env);
    expect(manifest.liveSessionIds).toEqual(["parent"]);
    const outcome = await executeDestroy(catalogue, index, manifest, fixture.env, AT);
    expect(outcome.ok).toBe(false);

    // The whole point of closing first: a half-destroyed session reads as gone but is not.
    for (const key of Object.keys(fixture.paths)) {
      expect(existsSync(fixture.paths[key]!)).toBe(true);
    }
    expect(getRow(catalogue, "parent")).not.toBeNull();
    expect(getRow(catalogue, "child")).not.toBeNull();
    const remaining = index.query("SELECT session_id FROM sessions").all() as { session_id: string }[];
    expect(remaining).toHaveLength(3);
  } finally {
    index.close();
    catalogue.close();
  }
});

test("destroy does not remove identities or the surfaces it cannot safely rewrite", async () => {
  const fixture = seed();
  const catalogue = openCatalogue(CATALOGUE_PATH());
  const index = openIndex(DB_PATH());
  try {
    catalogue.query("UPDATE catalogue SET identity_key = 'c:r:w' WHERE session_id = 'parent'").run();
    const manifest = await buildManifest(catalogue, index, "parent", fixture.env);
    expect(manifest.survivingIdentities).toEqual(["c:r:w"]);
  } finally {
    index.close();
    catalogue.close();
  }
});

test("markIncognito sets the flag and clears anything a model already wrote", () => {
  seed();
  const catalogue = openCatalogue(CATALOGUE_PATH());
  try {
    catalogue.query(
      "UPDATE catalogue SET enrichment_at = $at, enrichment_summary = 'leaked', "
      + "enrichment_title = 'Readable name' WHERE session_id = 'parent'",
    ).run({ $at: AT });

    markIncognito(catalogue, "parent", true, AT);
    const marked = getRow(catalogue, "parent");
    expect(marked?.incognito).toBe(true);
    // Marking is inherently late; clearing the stored summary is the half of the leak that CAN
    // still be undone locally, so it must actually happen rather than only stopping future sweeps.
    expect(marked?.enrichment).toBeNull();

    // The title survives on purpose: the sidebar shows open marked sessions and reads this column
    // directly, so clearing it would leave that section a list of bare session ids.
    const title = catalogue
      .query("SELECT enrichment_title, enrichment_summary FROM catalogue WHERE session_id = 'parent'")
      .get() as { enrichment_title: string | null; enrichment_summary: string | null };
    expect(title.enrichment_title).toBe("Readable name");
    expect(title.enrichment_summary).toBeNull();

    markIncognito(catalogue, "parent", false, AT);
    expect(getRow(catalogue, "parent")?.incognito).toBe(false);
    // Un-marking is not a restore: the cleared enrichment prose stays cleared.
    expect(getRow(catalogue, "parent")?.enrichment).toBeNull();
  } finally {
    catalogue.close();
  }
});
