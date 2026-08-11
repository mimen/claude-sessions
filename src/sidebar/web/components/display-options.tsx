/**
 * Display options for the list.
 *
 * A panel rather than another control in the header strip: the strip already carries scope,
 * clusters and grouping, all of which change *which* rows appear. What goes here changes how a
 * row is drawn, which is a different question and one worth having somewhere to grow.
 *
 * The layout choices are not equivalent trade-offs, so each carries the consequence rather than
 * only a name. Row height and scroll length are what separate them; title width is identical in
 * every option except `compact`.
 */
import type React from "react";
import { Menu } from "@base-ui/react/menu";
import { ROW_LAYOUTS, ROW_LAYOUT_HINTS, ROW_LAYOUT_LABELS, type RowLayout } from "../format.ts";
import { SettingsIcon } from "./icons.tsx";
import { cn } from "@/lib/utils";

export function DisplayOptions({ layout, onLayoutChange }: {
  readonly layout: RowLayout;
  readonly onLayoutChange: (next: RowLayout) => void;
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
              "w-72 origin-(--transform-origin) overflow-hidden rounded-(--radius) outline-none",
              "border border-border bg-popover p-1 text-popover-foreground shadow-md",
              "transition-[opacity,scale] data-ending-style:scale-98 data-starting-style:scale-98",
              "data-ending-style:opacity-0 data-starting-style:opacity-0",
            )}
          >
            <Menu.RadioGroup
              onValueChange={(next) => onLayoutChange(next as RowLayout)}
              value={layout}
            >
              <Menu.GroupLabel className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Row layout
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
                    {/* The tick keeps its width when absent, so the labels stay on one left edge. */}
                    <span aria-hidden="true" className="w-2.5 shrink-0 text-[10px]">
                      {option === layout ? "●" : ""}
                    </span>
                    {ROW_LAYOUT_LABELS[option]}
                  </span>
                  <span className="pl-4 text-[11px] leading-[1.35] text-muted-foreground">
                    {ROW_LAYOUT_HINTS[option]}
                  </span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
