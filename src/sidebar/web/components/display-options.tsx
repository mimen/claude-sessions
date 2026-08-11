/**
 * Display options for the list.
 *
 * A panel rather than another control in the header strip: the strip already carries scope,
 * clusters and grouping, all of which change *which* rows appear. What goes here changes how a
 * row is drawn, which is a different question and one worth having somewhere to grow.
 *
 * Open and closed rows are chosen separately because they are not the same decision. A closed row
 * has no status and no model, so a layout that arranges those facts means something different on
 * it, and the long tail of closed sessions is what a third line actually costs in scrolling.
 *
 * Choosing does not close the panel: the layouts are meant to be compared against the live list,
 * and reopening between each one makes that comparison harder than it needs to be.
 */
import type React from "react";
import { Menu } from "@base-ui/react/menu";
import {
  ROW_LAYOUTS,
  ROW_LAYOUT_HINTS_CLOSED,
  ROW_LAYOUT_HINTS_OPEN,
  ROW_LAYOUT_LABELS,
  type RowLayout,
  type RowLayouts,
} from "../format.ts";
import { SettingsIcon } from "./icons.tsx";
import { cn } from "@/lib/utils";

function LayoutChoice({ heading, hints, onChange, value }: {
  readonly heading: string;
  readonly hints: Readonly<Record<RowLayout, string>>;
  readonly onChange: (next: RowLayout) => void;
  readonly value: RowLayout;
}): React.ReactElement {
  return (
    <Menu.RadioGroup onValueChange={(next) => onChange(next as RowLayout)} value={value}>
      <Menu.GroupLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {heading}
      </Menu.GroupLabel>
      {ROW_LAYOUTS.map((option) => (
        <Menu.RadioItem
          className={cn(
            "relative flex cursor-pointer select-none flex-col gap-0.5 rounded-(--radius) px-2 py-1.5 outline-none",
            "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
          )}
          key={option}
          value={option}
        >
          <span className="flex items-center gap-1.5 text-[13px] leading-none">
            {/* The mark keeps its width when absent, so labels stay on one left edge. */}
            <span aria-hidden="true" className="w-2.5 shrink-0 text-[10px]">
              {option === value ? "●" : ""}
            </span>
            {ROW_LAYOUT_LABELS[option]}
          </span>
          <span className="pl-4 text-[11px] leading-[1.35] text-muted-foreground">
            {hints[option]}
          </span>
        </Menu.RadioItem>
      ))}
    </Menu.RadioGroup>
  );
}

export function DisplayOptions({ layouts, onChange }: {
  readonly layouts: RowLayouts;
  readonly onChange: (next: RowLayouts) => void;
}): React.ReactElement {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Display options"
        className={cn(
          "flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-input bg-transparent px-2",
          "text-[11px] text-muted-foreground transition-colors hover:bg-secondary",
          "focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
          "data-popup-open:bg-secondary",
        )}
      >
        <SettingsIcon className="size-3.5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" className="z-50 outline-none" sideOffset={4}>
          <Menu.Popup
            className={cn(
              "max-h-[min(560px,calc(100vh-16px))] w-72 overflow-y-auto rounded-(--radius) outline-none",
              "origin-(--transform-origin) border border-border bg-popover p-1 text-popover-foreground shadow-md",
              "transition-[opacity,scale] data-ending-style:scale-98 data-starting-style:scale-98",
              "data-ending-style:opacity-0 data-starting-style:opacity-0",
            )}
          >
            <LayoutChoice
              heading="Open sessions"
              hints={ROW_LAYOUT_HINTS_OPEN}
              onChange={(open) => onChange({ ...layouts, open })}
              value={layouts.open}
            />
            <Menu.Separator className="-mx-1 my-1 h-px bg-border" />
            <LayoutChoice
              heading="Closed sessions"
              hints={ROW_LAYOUT_HINTS_CLOSED}
              onChange={(closed) => onChange({ ...layouts, closed })}
              value={layouts.closed}
            />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
