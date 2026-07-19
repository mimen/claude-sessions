import { expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backfillWorkUnits } from "./backfill-work-units.ts";
import { openCatalogue, getRow, setCluster, setRole, setGusWork, stampPrFacts, setCompleted } from "./db.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import { getWorkUnit, findWorkUnitByAnchor } from "../state/work-units.ts";

const NOW = "2026-07-12T00:00:00Z";
const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.CCS_ROOT;
});

/** Point CCS_ROOT at a temp dir so both the catalogue and the work-unit store are isolated. */
function isolate(): void {
  const rt = mkdtempSync(join(tmpdir(), "ccs-backfill-"));
  roots.push(rt);
  process.env.CCS_ROOT = rt;
  ensureDataDir(); // create <root>/cache so openCatalogue can create the db file
}

test("backfill links anchored rows to a minted work-unit; second run is a no-op", () => {
  isolate();
  const db = openCatalogue(CATALOGUE_PATH());
  // a PR-anchored row, a GUS-anchored row, an anchorless row, and a retired row
  setCluster(db, "pr1", "pr-watch", NOW); stampPrFacts(db, "pr1", { prNumber: 12080, prRepo: "heroku/dashboard", prBranch: "b", prState: "open", prHeadSha: "s" }, NOW);
  setCluster(db, "gus1", "pr-watch", NOW); setGusWork(db, "gus1", "W-42", NOW);
  setCluster(db, "bare", "pr-watch", NOW); setRole(db, "bare", "pr-agent", NOW); // no anchor
  setCluster(db, "done", "pr-watch", NOW); stampPrFacts(db, "done", { prNumber: 999, prRepo: "a/b", prBranch: "b", prState: "merged", prHeadSha: "s" }, NOW); setCompleted(db, "done", true, NOW);
  db.close();

  const rc = backfillWorkUnits([]);
  expect(rc).toBe(0);

  const db2 = openCatalogue(CATALOGUE_PATH());
  const pr1 = getRow(db2, "pr1")!;
  const gus1 = getRow(db2, "gus1")!;
  expect(pr1.workUnitId).toBeTruthy();
  expect(gus1.workUnitId).toBeTruthy();
  expect(getRow(db2, "bare")!.workUnitId).toBeNull(); // anchorless → not linked
  expect(getRow(db2, "done")!.workUnitId).toBeNull(); // retired → skipped
  db2.close();

  // the minted work-unit carries the anchor attributes
  const wu = getWorkUnit("pr-watch", pr1.workUnitId!);
  expect(wu?.prNumber).toBe(12080);
  expect(findWorkUnitByAnchor("pr-watch", { prRepo: "heroku/dashboard", prNumber: 12080 })).toBe(pr1.workUnitId);

  // idempotent: re-running links nothing new
  const first = pr1.workUnitId;
  expect(backfillWorkUnits([])).toBe(0);
  const db3 = openCatalogue(CATALOGUE_PATH());
  expect(getRow(db3, "pr1")!.workUnitId).toBe(first);
  db3.close();
});

test("two sessions of the same PR converge to one work-unit id (dedup foundation)", () => {
  isolate();
  const db = openCatalogue(CATALOGUE_PATH());
  for (const sid of ["a", "b"]) {
    setCluster(db, sid, "pr-watch", NOW);
    stampPrFacts(db, sid, { prNumber: 555, prRepo: "x/y", prBranch: "b", prState: "open", prHeadSha: "s" }, NOW);
  }
  db.close();
  backfillWorkUnits([]);
  const db2 = openCatalogue(CATALOGUE_PATH());
  expect(getRow(db2, "a")!.workUnitId).toBe(getRow(db2, "b")!.workUnitId!);
  db2.close();
});

test("--dry-run reports but writes nothing", () => {
  isolate();
  const db = openCatalogue(CATALOGUE_PATH());
  setCluster(db, "pr1", "pr-watch", NOW);
  stampPrFacts(db, "pr1", { prNumber: 1, prRepo: "a/b", prBranch: "b", prState: "open", prHeadSha: "s" }, NOW);
  db.close();
  expect(backfillWorkUnits(["--dry-run"])).toBe(0);
  const db2 = openCatalogue(CATALOGUE_PATH());
  expect(getRow(db2, "pr1")!.workUnitId).toBeNull();
  db2.close();
});
