import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../index/schema.ts";
import { buildMerge } from "./merge.ts";
import { foreignOwner } from "./ownership.ts";

test("foreignOwner: foreign per merge → owner; local/unknown/no-merge → null", () => {
  const base = mkdtempSync(join(tmpdir(), "ccs-own-"));
  try {
    const mini = join(base, "mini");
    mkdirSync(mini, { recursive: true });
    const db = openIndex(join(mini, "index.db"));
    db.query(
      `INSERT INTO sessions (session_id, host, path, project_root, project_name, fallback_label,
                             file_mtime, file_size)
       VALUES ('s-mini', 'h', '/p', '/r', 'repo', 't', 1, 1)`,
    ).run();
    db.close();
    const mergePath = join(base, "merge.db");
    buildMerge([{ host: "Milads-Mac-mini", dir: mini }], mergePath, "2026-07-08T12:00:00Z");

    // From the laptop's point of view: the mini's row is foreign…
    expect(foreignOwner("s-mini", mergePath, "Milads-M3-2")).toBe("Milads-Mac-mini");
    // …from the mini's own point of view it isn't (case-insensitive labels).
    expect(foreignOwner("s-mini", mergePath, "milads-mac-mini")).toBeNull();
    // Sessions the merge doesn't know: no verdict.
    expect(foreignOwner("s-unknown", mergePath, "Milads-M3-2")).toBeNull();
    // No merge view at all: no verdict (pre-33 behavior preserved).
    expect(foreignOwner("s-mini", join(base, "nope.db"), "Milads-M3-2")).toBeNull();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
