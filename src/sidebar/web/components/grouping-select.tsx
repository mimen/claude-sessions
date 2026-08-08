/**
 * How the queue is arranged.
 *
 * A native select rather than a vendored menu: it is four options in a 400px drawer, and the
 * platform control brings its own keyboard handling, its own popover and no dependency. The
 * visible face is styled to match the buttons beside it; the real select sits transparently on
 * top so it stays a proper control.
 */
import type React from "react";
import { GROUPING_LABELS, GROUPING_MODES, type GroupingMode } from "../format.ts";
import { ChevronIcon, SortIcon } from "./icons.tsx";

export function GroupingSelect({ value, onChange }: {
  readonly value: GroupingMode;
  readonly onChange: (mode: GroupingMode) => void;
}): React.ReactElement {
  return (
    <div className="relative shrink-0">
      <div className="pointer-events-none flex h-7 items-center gap-1 rounded-md border border-input bg-transparent px-2 text-[11px] text-muted-foreground">
        <SortIcon className="size-3.5" />
        {GROUPING_LABELS[value]}
        <ChevronIcon className="size-3 opacity-60" />
      </div>
      <select
        aria-label="Arrange sessions"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        onChange={(event) => onChange(event.target.value as GroupingMode)}
        value={value}
      >
        {GROUPING_MODES.map((mode) => (
          <option key={mode} value={mode}>{GROUPING_LABELS[mode]}</option>
        ))}
      </select>
    </div>
  );
}
