import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { runtimeRoot } from "../paths.ts";
import type { Board } from "./types.ts";
import { parseBoard } from "./schema.ts";

/** ~/.ccs/clusters/<cluster>/cluster/board.json */
export function boardPath(cluster: string): string {
  return join(runtimeRoot(), "clusters", cluster, "cluster", "board.json");
}

/** Atomically write board.json (temp + rename). */
export function writeBoard(cluster: string, board: Board): void {
  const path = boardPath(cluster);
  const dir = join(runtimeRoot(), "clusters", cluster, "cluster");
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(board, null, 2), "utf8");
  renameSync(temp, path);
}

/** Read board.json; returns null if missing. ADR-D2 (2026-07-14): the raw JSON is zod-validated
 * against `BoardSchema` on every read (bug B11 fix), so a malformed row from a second, less-
 * dogfooded composer fails LOUDLY at the boundary instead of crashing deep in `buildMaps()` or
 * the TUI paint code with a cryptic error. A validation failure logs to stderr and returns null
 * (fail-open: a bad board is treated as no board, not a poisoned board).
 *
 * Tolerates the ADR-0031 state envelope (`{schemaVersion, updatedAt, source, data: <payload>}`)
 * — parseBoard() unwraps it automatically.
 */
export function readBoard(cluster: string): Board | null {
  const path = boardPath(cluster);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const result = parseBoard(raw);
  if (!result.ok) {
    console.error(`ccs: cluster "${cluster}" ${result.error}`);
    return null;
  }
  return result.value as unknown as Board;
}
