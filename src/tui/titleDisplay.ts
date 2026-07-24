/**
 * Display-time title normalisation.
 *
 * Some stored titles were captured while a Claude Code spinner was on screen, so the spinner
 * FRAME got baked into the title itself (observed in 41 catalogue `custom_title` rows, with
 * different rows holding different frames: "✳ Filter subagent session runs", "⠂ fix-ccs-startup-crash",
 * "⠐ Set up T3 code fork …"). We strip that decoration when rendering rather than mutating the
 * stored value, so the fix applies retroactively to old rows and to any newly polluted ones.
 *
 * Deliberately NARROW: only spinner glyphs are stripped, never arbitrary punctuation. A blanket
 * "trim non-letters" would corrupt legitimate labels — 2771 `(untitled)` rows would become
 * "untitled)", and `/loop` / `/Users/...` paths would lose their leading slash.
 */

/** Spinner decoration: the ✳-family asterisks and the whole Braille block, plus trailing space. */
const SPINNER_PREFIX = /^(?:[✳-✸✱✲✺✻❃❄❉❊❋⠀-⣿]+\s*)+/u;

/** Strip leading spinner decoration from a title for display. Returns the title unchanged when
 * stripping would leave nothing, so a title that is *only* a spinner never renders empty. */
export function stripSpinnerPrefix(title: string): string {
  const stripped = title.replace(SPINNER_PREFIX, "");
  return stripped.length > 0 ? stripped : title;
}
