/**
 * Interface glyphs, drawn on Lucide's geometry (ISC).
 *
 * Inlined rather than pulled from the package: a handful of shapes do not justify a dependency in
 * a bundle that must stay self-contained, and these are generic marks, not brand logos. Lucide's
 * proportions are used verbatim — a 24-unit grid with a 2-unit stroke — because the hand-drawn
 * approximations they replace were built on a 16-unit grid and read heavy and uneven at this size.
 */
import type React from "react";
import { cn } from "@/lib/utils";

type IconProps = { readonly className?: string };

function Glyph({ className, children }: IconProps & { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      // An SVG with no width or height falls back to the replaced-element default (300x150), which
      // inside a 16px control renders as a huge dark block rather than an icon. Every call site
      // passing a size is not something the type system can require, so the default lives here;
      // `cn` lets a call site's own size win.
      className={cn("size-4", className)}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

export function SearchIcon({ className }: IconProps): React.ReactElement {
  return (
    <Glyph className={className}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Glyph>
  );
}

export function SortIcon({ className }: IconProps): React.ReactElement {
  return (
    <Glyph className={className}>
      <path d="M3 6h18" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </Glyph>
  );
}

/** Sliders rather than a gear: these are display preferences, not application settings. */
export function SettingsIcon({ className }: IconProps): React.ReactElement {
  return (
    <Glyph className={className}>
      <path d="M4 6h10" />
      <path d="M18 6h2" />
      <circle cx="16" cy="6" r="2" />
      <path d="M4 18h6" />
      <path d="M14 18h6" />
      <circle cx="12" cy="18" r="2" />
    </Glyph>
  );
}

export function ChevronIcon({ className }: IconProps): React.ReactElement {
  return (
    <Glyph className={className}>
      <path d="m6 9 6 6 6-6" />
    </Glyph>
  );
}

export function CheckIcon({ className }: IconProps): React.ReactElement {
  return (
    <Glyph className={className}>
      <path d="M20 6 9 17l-5-5" />
    </Glyph>
  );
}

export function BookmarkIcon({ className }: IconProps): React.ReactElement {
  return (
    <Glyph className={className}>
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" />
    </Glyph>
  );
}

/**
 * A plain X, used for both close actions. The colour carries the difference in consequence, not
 * the shape: a panel-collapse glyph read as "tuck away", which is wrong for the sessionless case
 * where closing genuinely destroys the tab.
 */
export function CloseIcon({ className }: IconProps): React.ReactElement {
  return (
    <Glyph className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Glyph>
  );
}

export function FolderIcon({ className }: IconProps): React.ReactElement {
  return (
    <Glyph className={className}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Glyph>
  );
}

export function PinIcon({ className }: IconProps): React.ReactElement {
  return (
    <Glyph className={className}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Glyph>
  );
}

export function PinOffIcon({ className }: IconProps): React.ReactElement {
  return (
    <Glyph className={className}>
      <path d="M12 17v5" />
      <path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" />
      <path d="m2 2 20 20" />
      <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
    </Glyph>
  );
}

export function CopyIcon({ className }: IconProps): React.ReactElement {
  return (
    <Glyph className={className}>
      <rect height="14" rx="2" ry="2" width="14" x="8" y="8" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Glyph>
  );
}

/** A document with lines: the session's written summary, not a generic "info" circle. */
export function SummaryIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor"
      strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h10" />
    </svg>
  );
}
