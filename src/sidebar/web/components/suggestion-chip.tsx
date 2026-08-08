/**
 * Enrichment's verdict, as a label.
 *
 * Only a label. The chip briefly carried its own accept and dismiss buttons, which put a second
 * tick and a cross next to the row's own Complete and Archive controls -- four icons on a
 * one-line row, two of which did exactly what the two beside them did. Accepting a verdict IS
 * completing or archiving, so the row's existing controls are the accept path, and the chip goes
 * back to saying which verdict is outstanding.
 *
 * `handoff` states the verdict and offers nothing either way: passing a thread to another session
 * is work done inside the session, not a lifecycle flag flipped from a list.
 */
import type React from "react";
import type { SidebarSuggestion } from "../../projection.ts";
import { cn } from "@/lib/utils";

/** Colour carries the weight of the verb: finishing is affirmative, archiving is a dead end. */
const VERB_TONE: Readonly<Record<string, string>> = {
  complete: "text-[color:var(--action-confirm)]",
  archive: "text-[color:var(--action-shelve)]",
  handoff: "text-muted-foreground",
  continue: "text-muted-foreground",
};

const VERB_LABEL: Readonly<Record<string, string>> = {
  complete: "done?",
  archive: "archive?",
  handoff: "hand off",
  continue: "continue",
};

export interface SuggestionChipProps {
  readonly suggestion: SidebarSuggestion;
}

export function SuggestionChip({ suggestion }: SuggestionChipProps): React.ReactElement {
  const tone = VERB_TONE[suggestion.verb] ?? "text-muted-foreground";
  const label = VERB_LABEL[suggestion.verb] ?? suggestion.verb;

  return (
    <span
      className={cn(
        // A badge rather than bare text: at this size unbacked 9px type is invisible against a
        // list, and a suggestion nobody notices is the same as no suggestion at all.
        "shrink-0 rounded-(--radius) px-1 py-px text-[9px] leading-[12px] font-semibold tracking-tight",
        "bg-current/10",
        tone,
      )}
      // Junk cannot add a second visible fact: the schema guarantees it is an archive verdict.
      // It survives here as explanation on the one chip rather than as a redundant tag in the row.
      title={suggestion.junk
        ? `Junk session. Archive recommended.${suggestion.reason ? ` ${suggestion.reason}` : ""}`
        : suggestion.reason ?? undefined}
    >
      {label}
    </span>
  );
}
