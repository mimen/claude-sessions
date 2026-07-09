import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, setRole, setSubstrate, setCustomTitle, addTag } from "./db.ts";
import { openIndex } from "../index/schema.ts";
import { buildMerge, openMerge, mergedRows, ownerOf, discoverSources } from "./merge.ts";

const NOW = "2026-07-08T12:00:00Z";

/** A machine's data dir fixture: catalogue.db + index.db like ~/.claude-sessions. */
function makeSource(base: string, machine: string): string {
  const dir = join(base, machine);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function indexSession(dir: string, sessionId: string, title: string, lastTs: string): void {
  const db = openIndex(join(dir, "index.db"));
  db.query(
    `INSERT INTO sessions (session_id, host, path, project_root, project_name, fallback_label,
                           file_mtime, file_size, last_ts, msg_count)
     VALUES ($id, 'h', '/p', '/r', 'repo', $title, 1, 1, $ts, 3)`,
  ).run({ $id: sessionId, $title: title, $ts: lastTs });
  db.close();
}

function catalogueWrite(dir: string, fn: (db: Database) => void): void {
  const db = openCatalogue(join(dir, "catalogue.db"));
  fn(db);
  db.close();
}

test("merge unions sessions from all sources, tagged with the owning machine", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-merge-"));
  try {
    const laptop = makeSource(base, "laptop");
    const mini = makeSource(base, "mini");
    indexSession(laptop, "s-lap", "Laptop Session", "2026-07-08T10:00:00Z");
    indexSession(mini, "s-min", "Mini Session", "2026-07-08T11:00:00Z");
    catalogueWrite(laptop, (db) => setRole(db, "s-lap", "todoist-scout", NOW));
    catalogueWrite(mini, (db) => {
      setRole(db, "s-min", "ops-watch", NOW);
      setSubstrate(db, "s-min", "codex", NOW);
    });

    const out = join(base, "merge.db");
    const stats = buildMerge(
      [
        { host: "laptop", dir: laptop },
        { host: "mini", dir: mini },
      ],
      out,
      NOW,
    );
    expect(stats.sessions).toBe(2);

    const db = openMerge(out)!;
    const rows = mergedRows(db);
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    expect(byId.get("s-lap")!.host).toBe("laptop");
    expect(byId.get("s-lap")!.role).toBe("todoist-scout");
    expect(byId.get("s-lap")!.title).toBe("Laptop Session");
    expect(byId.get("s-min")!.host).toBe("mini");
    expect(byId.get("s-min")!.substrate).toBe("codex");
    expect(ownerOf(db, "s-min")).toBe("mini");
    expect(ownerOf(db, "s-lap")).toBe("laptop");
    expect(ownerOf(db, "unknown")).toBeNull();
    db.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("uncatalogued indexed sessions still appear (the mini-zombie case), catalogue-only rows too", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-merge-"));
  try {
    const mini = makeSource(base, "mini");
    indexSession(mini, "zombie", "Forgotten Mini Loop", "2026-06-01T00:00:00Z"); // no catalogue row
    catalogueWrite(mini, (db) => setCustomTitle(db, "ghost", "Catalogued But Unindexed", NOW)); // no index row

    const out = join(base, "merge.db");
    buildMerge([{ host: "mini", dir: mini }], out, NOW);
    const db = openMerge(out)!;
    const byId = new Map(mergedRows(db).map((r) => [r.sessionId, r]));
    expect(byId.get("zombie")!.title).toBe("Forgotten Mini Loop");
    expect(byId.get("ghost")!.customTitle).toBe("Catalogued But Unindexed");
    db.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("conflicting catalogue rows: the indexed owner's row wins over a foreign write", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-merge-"));
  try {
    const laptop = makeSource(base, "laptop");
    const mini = makeSource(base, "mini");
    indexSession(mini, "s1", "Mini-Owned", "2026-07-08T10:00:00Z"); // transcript lives on mini
    // Pre-33 cross-write: the laptop catalogued the mini's session with a different role.
    catalogueWrite(laptop, (db) => setRole(db, "s1", "laptop-opinion", "2026-07-08T13:00:00Z"));
    catalogueWrite(mini, (db) => setRole(db, "s1", "mini-truth", NOW));

    const out = join(base, "merge.db");
    buildMerge(
      [
        { host: "laptop", dir: laptop },
        { host: "mini", dir: mini },
      ],
      out,
      NOW,
    );
    const db = openMerge(out)!;
    const row = mergedRows(db).find((r) => r.sessionId === "s1")!;
    expect(row.host).toBe("mini"); // owner = whose index has the transcript
    expect(row.role).toBe("mini-truth"); // owner's catalogue row wins, even if older
    db.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("tags merge across sources", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-merge-"));
  try {
    const mini = makeSource(base, "mini");
    indexSession(mini, "s1", "T", "2026-07-08T10:00:00Z");
    catalogueWrite(mini, (db) => addTag(db, "s1", "Glizzy Galaxy"));
    const out = join(base, "merge.db");
    buildMerge([{ host: "mini", dir: mini }], out, NOW);
    const db = openMerge(out)!;
    const tags = db.query("SELECT entity FROM merged_tags WHERE session_id = 's1'").all() as { entity: string }[];
    expect(tags.map((t) => t.entity)).toEqual(["Glizzy Galaxy"]);
    db.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a version-lagging replica index is READ, never migrated or wiped (archive integrity)", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-merge-"));
  try {
    const mini = makeSource(base, "mini");
    indexSession(mini, "s1", "Old Schema Session", "2026-07-08T10:00:00Z");
    // Simulate a replica produced by an OLDER ccs: user_version differs from the current one.
    const idx = new Database(join(mini, "index.db"));
    idx.exec("PRAGMA user_version = 1;");
    idx.close();
    const before = Bun.file(join(mini, "index.db")).size;

    const out = join(base, "merge.db");
    const stats = buildMerge([{ host: "mini", dir: mini }], out, NOW);
    expect(stats.skipped).toEqual([]);
    const db = openMerge(out)!;
    expect(mergedRows(db).find((r) => r.sessionId === "s1")!.title).toBe("Old Schema Session");
    db.close();

    // The replica itself is untouched: same size, same (old) user_version — openIndex would
    // have dropped and recreated it.
    expect(Bun.file(join(mini, "index.db")).size).toBe(before);
    const check = new Database(join(mini, "index.db"));
    expect((check.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    expect((check.query("SELECT COUNT(*) n FROM sessions").get() as { n: number }).n).toBe(1);
    check.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("one corrupt source is skipped with a note; the rest of the fleet still merges", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-merge-"));
  try {
    const good = makeSource(base, "good");
    indexSession(good, "s-good", "Fine", "2026-07-08T10:00:00Z");
    const torn = makeSource(base, "torn");
    writeFileSync(join(torn, "catalogue.db"), "this is not a sqlite file"); // torn mid-rsync

    const out = join(base, "merge.db");
    const stats = buildMerge(
      [
        { host: "torn", dir: torn },
        { host: "good", dir: good },
      ],
      out,
      NOW,
    );
    expect(stats.skipped.length).toBe(1);
    expect(stats.skipped[0]).toContain("torn");
    const db = openMerge(out)!;
    expect(mergedRows(db).map((r) => r.sessionId)).toEqual(["s-good"]);
    db.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("discoverSources finds local + replicas, replicas first", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-merge-"));
  try {
    const local = makeSource(base, "local-data");
    const replicas = join(base, "replicas");
    mkdirSync(join(replicas, "Milads-M3-2", "claude-sessions"), { recursive: true });
    mkdirSync(join(replicas, "no-data-here"), { recursive: true }); // no claude-sessions inside → skipped

    const sources = discoverSources(local, "Milads-Mac-mini", replicas);
    expect(sources.map((s) => s.host)).toEqual(["Milads-M3-2", "Milads-Mac-mini"]);
    expect(sources[0]!.dir).toBe(join(replicas, "Milads-M3-2", "claude-sessions"));
    expect(sources[1]!.dir).toBe(local);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a replica of the merge host itself is skipped (no self-duplication)", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-merge-"));
  try {
    const local = makeSource(base, "local-data");
    const replicas = join(base, "replicas");
    mkdirSync(join(replicas, "Milads-Mac-mini", "claude-sessions"), { recursive: true });
    const sources = discoverSources(local, "Milads-Mac-mini", replicas);
    expect(sources.map((s) => s.host)).toEqual(["Milads-Mac-mini"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
