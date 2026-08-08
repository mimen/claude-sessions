import type React from "react";
import { cn } from "@/lib/utils";

export type BrowserStatusIcon =
  | "bell"
  | "bolt"
  | "hand-raised"
  | "pause"
  | "checkmark-circle"
  | "dot";

/** Map cmux's supported SF Symbol names to browser-safe generic glyphs. */
export function browserStatusIcon(icon: string | null): BrowserStatusIcon {
  switch (icon) {
    case "bell.fill":
      return "bell";
    case "bolt.fill":
      return "bolt";
    case "hand.raised.fill":
      return "hand-raised";
    case "pause.fill":
      return "pause";
    case "checkmark.circle.fill":
      return "checkmark-circle";
    default:
      return "dot";
  }
}

/**
 * cmux currently publishes status colors as hex. Accept only valid CSS hex forms so an untrusted
 * status value never reaches an inline style; valid values are returned without normalization.
 */
export function validatedStatusColor(color: string | null): string | undefined {
  return color && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)
    ? color
    : undefined;
}

interface StatusIconProps {
  readonly color: string | null;
  readonly icon: string | null;
  readonly className?: string;
}

/** Render cmux's status icon without depending on Apple's SF Symbols font. */
export function StatusIcon({ color, icon, className }: StatusIconProps): React.ReactElement {
  const glyph = browserStatusIcon(icon);
  const validColor = validatedStatusColor(color);
  const style = validColor ? { color: validColor } : undefined;

  if (glyph === "dot") {
    return (
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full bg-current text-muted-foreground", className)}
        style={style}
      />
    );
  }

  return (
    <svg
      aria-hidden="true"
      className={cn("size-2.5 shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      style={style}
      viewBox="0 0 16 16"
    >
      {glyph === "bell" ? (
        <>
          <path
            d="M8 1.7a3.7 3.7 0 0 0-3.7 3.7v2.1c0 1.2-.4 2.3-1.2 3.2l-.5.6c-.3.4 0 1 .5 1h9.8c.5 0 .8-.6.5-1l-.5-.6a5 5 0 0 1-1.2-3.2V5.4A3.7 3.7 0 0 0 8 1.7Z"
            fill="currentColor"
            stroke="none"
          />
          <path d="M6.3 13.2a1.8 1.8 0 0 0 3.4 0Z" fill="currentColor" stroke="none" />
        </>
      ) : null}
      {glyph === "bolt" ? (
        <path d="M9.1 1.7 3.8 8.5h3.8l-.7 5.8 5.3-7H8.5Z" fill="currentColor" stroke="none" />
      ) : null}
      {glyph === "hand-raised" ? (
        <path d="M4.1 8V5.1a1 1 0 0 1 2 0v2.1-3.5a1 1 0 0 1 2 0v3.5-2.8a1 1 0 0 1 2 0v3.1-1.8a1 1 0 0 1 2 0v3.8c0 3-1.7 4.8-4.6 4.8-2 0-3.1-.9-4-2.4L2.2 9.8a1.1 1.1 0 0 1 1.9-1.1l1 1.5" />
      ) : null}
      {glyph === "pause" ? (
        <>
          <rect fill="currentColor" height="10" rx="1" stroke="none" width="3.2" x="3.6" y="3" />
          <rect fill="currentColor" height="10" rx="1" stroke="none" width="3.2" x="9.2" y="3" />
        </>
      ) : null}
      {glyph === "checkmark-circle" ? (
        <>
          <circle cx="8" cy="8" r="5.8" />
          <path d="m5 8.1 2 2 4-4.3" />
        </>
      ) : null}
    </svg>
  );
}
