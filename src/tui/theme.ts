/**
 * Central palette. Primary text stays bright/default for contrast; the only "muted" tone is
 * a readable medium-grey hex (NOT ANSI `gray`/dimColor, which renders as unreadable dark-grey
 * on a dark terminal). ANSI dark tones are reserved for borders.
 */
export const theme = {
  accent: "cyan",
  /** Selected-row highlight bar. */
  selBg: "cyan",
  selFg: "black",
  /** Title-source marks. */
  sourceNative: "green",
  sourceCodex: "yellow",
  sourceFallback: "#7f8896",
  /** Primary list text. */
  title: "white",
  project: "cyan",
  branch: "#86b3ff",
  /** Readable muted tone for secondary text (labels, counts, footer). */
  muted: "#9aa3b2",
  /** Even quieter — borders / peek text only. */
  faint: "#6b7280",
  /** Project header accent. */
  header: "cyanBright",
  /** Recent vs old activity. */
  ageRecent: "greenBright",
  ageOld: "#9aa3b2",
  /** Header/dashboard chrome. */
  headerBorder: "#3a4150",
  headerLabel: "#9aa3b2",
  headerValue: "white",
  /**
   * Cost tiers — deliberately restrained. Most sessions read as calm neutral text; warmth is
   * reserved for genuine outliers so the eye is drawn only to real spend, not to every row.
   */
  costNil: "#5b6472", // < $1: barely-there
  costLow: "#9aa3b2", // $1–$100: neutral, same weight as other secondary text
  costMid: "#cbb079", // $100–$500: soft gold
  costHigh: "#e0876a", // > $500: soft coral (never pure red)
} as const;

/** Per-role accent for the role column — pulled from `role.toml color = "#RRGGBB"` so ccs and the
 * cmux tab paint from the SAME source of truth (the hex is passed through verbatim to both, no
 * name→hex translation drift). Falls back to faint when the role declares no color, so any role
 * without an assignment (e.g. worker) reads as neutral. Memoized: role reads aren't hot but they
 * happen per row on every TUI render, so building the map once per process keeps the list snappy. */
let roleColorMap: Map<string, string | null> | null = null;
function loadRoleColors(): Map<string, string | null> {
  if (roleColorMap) return roleColorMap;
  const m = new Map<string, string | null>();
  try {
    // Lazy require to keep this file free of a config-tree read at import time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { allRolesFromFiles } = require("../roles/role-files.ts") as typeof import("../roles/role-files.ts");
    for (const [name, def] of allRolesFromFiles()) m.set(name, def.color);
  } catch {
    /* config unreadable → empty map, everything falls to faint (never throws) */
  }
  roleColorMap = m;
  return m;
}

/** The role column's color for a given role, or faint when the role declares no accent. */
export function roleColor(role: string | null | undefined): string {
  if (!role) return theme.faint;
  return loadRoleColors().get(role) ?? theme.faint;
}

/** Reset the memoized role-color map (tests only; role reads are per-process in production). */
export function _resetRoleColorCache(): void { roleColorMap = null; }

/** Whether an age label (from formatAge) counts as "recent" for brighter coloring. */
export function isRecentAge(age: string): boolean {
  return age === "now" || age.endsWith("m") || age.endsWith("h");
}

/** Grade a USD cost into a theme color (shared by list, section headers, preview, dashboard). */
export function costColor(usd: number): string {
  if (usd < 1) return theme.costNil;
  if (usd < 100) return theme.costLow;
  if (usd < 500) return theme.costMid;
  return theme.costHigh;
}
