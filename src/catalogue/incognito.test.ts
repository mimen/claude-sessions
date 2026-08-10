import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "./db-schema.ts";
import { setIncognito } from "./db-mutations.ts";
import { openIndex } from "../index/schema.ts";
import { CATALOGUE_PATH, DB_PATH } from "../paths.ts";
import { resolvePredecessors } from "./lineage.ts";
import { incognitoSessionIds } from "./incognito.ts";
import { enrichCandidates } from "../enrich/enrich.ts";
import { readWorldState } from "../enrich/world.ts";

/**
 * The three paths that carry one session's content somewhere else. Everything else incognito
 * touches is a listing, and a listing that leaks is embarrassing; these leak the transcript
 * itself -- to the model gateway, or into a different session's prompt -- so each gets its own
 * test rather than being folded into a single "is it hidden" assertion.
 */

const AT = "2026-08-09T00:00:00Z";
const roots: string[] = [];
const priorRoot = process.env.CCS_ROOT;

afterEach(() => {
  if (priorRoot === undefined) delete process.env.CCS_ROOT;
  else process.env.CCS_ROOT = priorRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Two sessions sharing one identity, in the same cwd, so every path below has something to find. */
function seed(): void {
  const root = mkdtempSync(join(tmpdir(), "ccs-incognito-"));
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
      $at,$at,40,1,1,$id,$id,'',0,NULL,$id,0,'{}')`,
  );
  insert.run({ $id: "hidden", $path: "/store/hidden.jsonl", $at: AT });
  insert.run({ $id: "shown", $path: "/store/shown.jsonl", $at: AT });
  insert.run({ $id: "reader", $path: "/store/reader.jsonl", $at: AT });
  index.close();

  const catalogue = openCatalogue(CATALOGUE_PATH());
  // identity_key is written directly: minting a real identity would need a materialized per-role
  // table and a config root, none of which these three paths read.
  for (const id of ["hidden", "shown", "reader"]) {
    catalogue.query(
      "INSERT INTO catalogue (session_id, identity_key, updated_at) VALUES ($id, 'c:control:w', $at) " +
      "ON CONFLICT(session_id) DO UPDATE SET identity_key = excluded.identity_key",
    ).run({ $id: id, $at: AT });
  }
  setIncognito(catalogue, "hidden", true, AT);
  catalogue.close();
}

test("an incognito session is never an enrichment candidate", () => {
  seed();
  const catalogue = openCatalogue(CATALOGUE_PATH());
  const index = openIndex(DB_PATH());
  try {
    // Enrichment POSTs a transcript tail to the model gateway. This is the only exclusion in the
    // system where being wrong means content has already left the machine.
    const ids = enrichCandidates(index, catalogue).map((candidate) => candidate.row.sessionId);
    expect(ids).not.toContain("hidden");
  } finally {
    index.close();
    catalogue.close();
  }
});

test("an incognito session is never offered as a predecessor to another session", () => {
  seed();
  const catalogue = openCatalogue(CATALOGUE_PATH());
  const index = openIndex(DB_PATH());
  try {
    const forReader = resolvePredecessors(catalogue, index, "reader").map((e) => e.sessionId);
    expect(forReader).toContain("shown");
    expect(forReader).not.toContain("hidden");

    // The restriction is on what leaks OUT of the marked session, not on what it can see: an
    // incognito session still reads its own non-incognito lineage.
    const forHidden = resolvePredecessors(catalogue, index, "hidden").map((e) => e.sessionId);
    expect(forHidden).toContain("shown");
  } finally {
    index.close();
    catalogue.close();
  }
});

test("an incognito session is not counted in the world state composed for another session", () => {
  seed();
  const catalogue = openCatalogue(CATALOGUE_PATH());
  const index = openIndex(DB_PATH());
  try {
    const exclude = incognitoSessionIds(catalogue);
    expect([...exclude]).toEqual(["hidden"]);

    const query = { sessionId: "reader", cwd: "/repo", branch: null, lastTs: "2026-08-08T00:00:00Z" };
    const withFilter = readWorldState(index, query, exclude);
    const withoutFilter = readWorldState(index, query);
    // The count itself is the leak here: "2 other sessions worked here since" against a visible
    // list of one is enough to tell the reading model that something is being kept from it.
    expect(withFilter.sessionsSince).toBe(withoutFilter.sessionsSince - 1);
    expect(withFilter.mostRecentSince).not.toBe("hidden");
  } finally {
    index.close();
    catalogue.close();
  }
});
