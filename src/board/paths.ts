import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { runtimeRoot } from "../paths.ts";
import type { Board } from "./types.ts";

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

/** Read board.json; returns null if missing. Throws on parse errors (loud). */
export function readBoard(cluster: string): Board | null {
  const path = boardPath(cluster);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as Board;
}
