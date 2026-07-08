import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PREFS_PATH } from "../paths.ts";

/**
 * Remembered TUI preferences — a tiny JSON so the session browser reopens the way it
 * was left (currently just the active view). Best-effort: a missing/corrupt file falls
 * back to defaults, and a failed write is swallowed (prefs are a convenience, not state).
 */
export interface Prefs {
  view?: string;
}

export function loadPrefs(): Prefs {
  try {
    if (!existsSync(PREFS_PATH)) return {};
    return JSON.parse(readFileSync(PREFS_PATH, "utf8")) as Prefs;
  } catch {
    return {};
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    mkdirSync(dirname(PREFS_PATH), { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
  } catch {
    // best-effort — prefs are a nicety, never block the UI on a write failure.
  }
}
