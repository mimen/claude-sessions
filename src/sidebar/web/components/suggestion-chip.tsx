/**
 * Enrichment's verdict, as something you can act on.
 *
 * The catalogue already holds a recommendation for every enriched session, and 280 of them
 * currently contradict where the session actually sits. That backlog is only worth surfacing if
 * clearing it costs one click, so the chip is both the label and the button.
 *
 * `handoff` renders but does not act. Passing a thread to another session is work done inside the
 * session, not a lifecycle flag flipped from a list, so the chip states the verdict and stops
 * there rather than offering a button that would lie about what it does.
 */
import type React from "react";
import type { SidebarSuggestion } from "../../projection.ts";
import { cn } from "@/lib/utils";
import { ArchiveIcon, CheckIcon, CloseIcon } from "./icons.tsx";

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
  /** Provided only when the verb maps to a lifecycle action the sidebar can apply. */
  readonly onAccept?: () => void;
  readonly onDismiss?: () => void;
  /** Show the accept/dismiss buttons. Off until the row is hovered, so lists read as text. */
  readonly revealed: boolean;
}

export function SuggestionChip({
  suggestion,
  onAccept,
  onDismiss,
  revealed,
}: SuggestionChipProps): React.ReactElement {
  const tone = VERB_TONE[suggestion.verb] ?? "text-muted-foreground";
  const label = VERB_LABEL[suggestion.verb] ?? suggestion.verb;
  const showButtons = revealed && (onAccept !== undefined || onDismiss !== undefined);

  return (
    <span
      className="flex shrink-0 items-center gap-1"
      // The reason is why enrichment reached this verdict; v40 guarantees one for archive and
      // handoff, and guarantees its absence for complete, where it only restated the verdict.
      title={suggestion.reason ?? undefined}
    >
      {showButtons ? (
        <>
          {onAccept ? (
            <span
              aria-label={`Apply ${suggestion.verb}`}
              className={cn(
                "flex size-4 cursor-pointer items-center justify-center rounded-(--radius)",
                "hover:bg-background/80",
                tone,
              )}
              onClick={(event) => {
                // The row itself opens the session; a chip click must not do both.
                event.stopPropagation();
                onAccept();
              }}
              role="button"
            >
              {suggestion.verb === "complete" ? <CheckIcon /> : <ArchiveIcon />}
            </span>
          ) : null}
          {onDismiss ? (
            <span
              aria-label="Dismiss suggestion"
              className={cn(
                "flex size-4 cursor-pointer items-center justify-center rounded-(--radius)",
                "text-muted-foreground hover:bg-background/80 hover:text-foreground",
              )}
              onClick={(event) => {
                event.stopPropagation();
                onDismiss();
              }}
              role="button"
            >
              <CloseIcon />
            </span>
          ) : null}
        </>
      ) : (
        <span
          className={cn(
            // A badge rather than bare text: at this size unbacked 9px type is invisible against a
            // list, and a suggestion nobody notices is the same as no suggestion at all.
            "rounded-(--radius) px-1 py-px text-[9px] leading-[12px] font-semibold tracking-tight",
            "bg-current/10",
            tone,
          )}
        >
          {/* Junk is enrichment saying the session was never worth starting. It always rides an
              archive verb, so the label carries the extra judgement rather than a second chip. */}
          {suggestion.junk ? "junk" : label}
        </span>
      )}
    </span>
  );
}
