import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR-0068 (enforced, lighter form): the catalogue's MUTATION surface has a bounded set of
 * importers. This is the "who can change the catalogue" answer as an enforced test rather than a
 * dependency-cruiser toolchain — the repo has no eslint/depcruise, so a grep-test is the
 * proportionate mechanism. It fails the build if a NEW module starts importing a raw mutation
 * function from db.ts, forcing that write to go through the command layer (commands.ts) or to be
 * consciously added to the allowlist here with a reason.
 *
 * The full ADR-0068 physical split (db-schema / db-queries / db-mutations) is deferred; this test
 * captures its GUARANTEE (bounded, auditable mutation surface) so the boundary can't erode
 * meanwhile.
 */

// Every db.ts export that MUTATES the catalogue (writes a row). Queries + pure helpers are free.
const MUTATION_FNS = [
  "ensureRow", "touch", "setCustomTitle", "setKind", "setCompleted", "setArchived", "setParked",
  "setResumeId", "setKey", "setParent", "setRole", "setResumeCommand", "setProject", "setCluster",
  "setGusWork", "setWorkUnitId", "setStage", "setActivity", "setStatusLine", "setMeta",
  "setSessionEpic", "stampPrFacts", "addTag", "removeTag",
];

/**
 * The SANCTIONED mutators — the only non-test modules allowed to import a raw mutation fn.
 * Each is a platform-internal writer with a reason; a new entry needs a deliberate justification.
 */
const ALLOWLIST: Record<string, string> = {
  "catalogue/commands.ts": "the command layer — the canonical mutation door (validation + stamping)",
  "catalogue/command.ts": "the natural-language catalogue editor — a command surface (applies inferred mutations)",
  "catalogue/backfill-work-units.ts": "one-time ADR-0057 migration command (setWorkUnitId)",
  "resume/new-session.ts": "the spawn primitive — writes a session's birth metadata (ADR-0065)",
  "roles/materialize.ts": "touches updated_at when materializing role config",
  "hooks/register.ts": "SessionStart hook — touches updated_at (the heartbeat)",
  "hooks/worker-stop-command.ts": "Stop hook — touches updated_at (the heartbeat)",
  "tui/App.tsx": "the TUI's direct user actions (rename/complete/archive) — interactive, in-process",
};

const SRC = new URL("../", import.meta.url).pathname; // .../src/

/** Recursively list .ts/.tsx files under src, excluding tests + the db module itself. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
    if (full.endsWith("catalogue/db.ts")) continue; // the module that DEFINES them
    out.push(full);
  }
  return out;
}

/** The import specifiers a file pulls from the CATALOGUE db module (best-effort: scan import
 * blocks). `inCatalogueDir` gates the same-dir `./db` form so a `src/skills/db.ts` sibling (a
 * DIFFERENT db that happens to export addTag/removeTag) isn't mistaken for the catalogue db. */
function dbImports(src: string, inCatalogueDir: boolean): string[] {
  const names: string[] = [];
  // A cross-dir import must spell out `.../catalogue/db`. A bare `./db` counts ONLY when the
  // importing file lives in src/catalogue/ (then `./db` IS the catalogue db).
  const sameDir = inCatalogueDir ? "\\.\\/db|" : "";
  const re = new RegExp(
    `import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*["'](?:${sameDir}[^"']*\\/catalogue\\/db)(?:\\.ts)?["']`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const raw of m[1]!.split(",")) {
      const id = raw.replace(/\btype\b/, "").trim().split(/\s+as\s+/)[0]!.trim();
      if (id) names.push(id);
    }
  }
  return names;
}

test("only sanctioned modules import a raw catalogue mutation fn (ADR-0068 boundary)", () => {
  const violations: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = file.slice(file.indexOf("/src/") + 5); // e.g. "hooks/register.ts"
    const inCatalogueDir = rel.startsWith("catalogue/");
    const mutated = dbImports(readFileSync(file, "utf8"), inCatalogueDir).filter((n) => MUTATION_FNS.includes(n));
    if (mutated.length === 0) continue;
    if (!(rel in ALLOWLIST)) {
      violations.push(`${rel} imports mutation fn(s) [${mutated.join(", ")}] — route through commands.ts or add to the ADR-0068 allowlist with a reason`);
    }
  }
  expect(violations).toEqual([]);
});
