import { renameSync, cpSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { SkillRecord, Ecosystem } from "./scan.ts";
import { type Result, ok, err } from "../result.ts";

/** Where archived skills go: a dated graveyard in the vault with an origin note for undo. */
export const ARCHIVE_ROOT = join(homedir(), "Documents", "milad-vault", "_archive", "skills");

const PROTECTED: ReadonlySet<Ecosystem> = new Set(["plugin", "codex", "cursor", "hermes"]);

/**
 * Why a record must not be archived from ccs, or null if it's fair game.
 * Other tools' installs and plugin caches are managed by their own tool.
 */
export function archiveGuard(rec: SkillRecord): string | null {
  if (PROTECTED.has(rec.ecosystem)) {
    return `${rec.ecosystem} copies are managed by that tool — archive from there, not ccs`;
  }
  if (rec.path.includes("/_archive/")) return "already archived";
  return null;
}

/** Move the physical dir into the vault graveyard, leaving an origin.txt breadcrumb. */
export function archiveSkill(rec: SkillRecord, nowIso: string, archiveRoot: string = ARCHIVE_ROOT): Result<string> {
  const guard = archiveGuard(rec);
  if (guard) return err(new Error(guard));
  const date = nowIso.slice(0, 10);
  let dest = join(archiveRoot, `${date}-${basename(rec.path)}`);
  let n = 2;
  while (existsSync(dest)) dest = join(archiveRoot, `${date}-${basename(rec.path)}-${n++}`);
  try {
    mkdirSync(archiveRoot, { recursive: true });
    try {
      renameSync(rec.path, dest);
    } catch {
      // Cross-device (or symlink weirdness): copy the resolved content, then remove the original.
      cpSync(rec.realPath, dest, { recursive: true });
      rmSync(rec.path, { recursive: true, force: true });
    }
    writeFileSync(join(dest, "origin.txt"), `archived: ${nowIso}\nfrom: ${rec.path}\nrealpath: ${rec.realPath}\n`);
    return ok(dest);
  } catch (e) {
    return err(new Error(`archive failed: ${(e as Error).message}`));
  }
}
