/**
 * One hover-revealed control on a row.
 *
 * Shared by the full and compact rows so an action means the same thing and looks the same wherever
 * it appears; the tone states the consequence of the action, not the kind of thing acted on.
 */
import type React from "react";
import { cn } from "@/lib/utils";

export type ActionTone = "confirm" | "shelve" | "dismiss" | "destroy";

const ACTION_TONES: Readonly<Record<ActionTone, string>> = {
  confirm: "text-[color:var(--action-confirm)]",
  shelve: "text-[color:var(--action-shelve)]",
  /** Closing a session's workspace is housekeeping — the session and its transcript survive. */
  dismiss: "text-muted-foreground",
  /** Closing a sessionless tab really is the end of it, so it reads as destructive. */
  destroy: "text-[color:var(--action-destroy)]",
};

export function RowAction({ label, onClick, tone, disabled = false, children }: {
  readonly label: string;
  readonly onClick: () => void;
  readonly tone: ActionTone;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      aria-disabled={disabled}
      aria-label={label}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-sm border border-border",
        "bg-muted/40 transition-colors hover:bg-muted",
        disabled
          ? "cursor-default text-muted-foreground opacity-30"
          : `cursor-pointer ${ACTION_TONES[tone]}`,
      )}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onClick();
      }}
      role="button"
      title={label}
    >
      {children}
    </span>
  );
}

