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
