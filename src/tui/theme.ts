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
} as const;

/** Whether an age label (from formatAge) counts as "recent" for brighter coloring. */
export function isRecentAge(age: string): boolean {
  return age === "now" || age.endsWith("m") || age.endsWith("h");
}
