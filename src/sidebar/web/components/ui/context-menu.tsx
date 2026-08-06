"use client";

/**
 * Context menu, built on Base UI's primitive in the shadcn new-york-v4 shape.
 *
 * Written rather than vendored: shadcn's own context menu targets Radix, and the app already
 * depends on Base UI for the preview card, so pulling a second menu stack in would mean two
 * portal/focus implementations fighting over the same page.
 *
 * The surface follows the sidebar's own theme rather than the shadcn defaults — square corners
 * from `--radius`, the same `popover` tokens the preview card uses, and a highlight that keys off
 * Base UI's `data-highlighted` so pointer and keyboard focus look identical.
 */
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import type React from "react";
import { cn } from "@/lib/utils";

export const ContextMenu: typeof ContextMenuPrimitive.Root = ContextMenuPrimitive.Root;

export function ContextMenuTrigger({
  ...props
}: ContextMenuPrimitive.Trigger.Props): React.ReactElement {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

export function ContextMenuContent({
  className,
  children,
  ...props
}: ContextMenuPrimitive.Popup.Props): React.ReactElement {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-50 outline-none" data-slot="context-menu-positioner">
        <ContextMenuPrimitive.Popup
          className={cn(
            // The popup itself holds focus whenever no item is highlighted, so the UA focus ring
            // would outline the entire menu the moment the pointer sits between items. Keyboard
            // users lose nothing: the highlight moves to an item on the first arrow key.
            "outline-none select-none",
            "min-w-40 origin-(--transform-origin) overflow-hidden rounded-(--radius)",
            "border border-border bg-popover p-1 text-popover-foreground shadow-md",
            "transition-[opacity,scale] data-ending-style:scale-98 data-starting-style:scale-98",
            "data-ending-style:opacity-0 data-starting-style:opacity-0",
            className,
          )}
          data-slot="context-menu-content"
          {...props}
        >
          {children}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  disabled = false,
  ...props
}: ContextMenuPrimitive.Item.Props & { readonly disabled?: boolean }): React.ReactElement {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-(--radius)",
        "px-2 py-1.5 text-[13px] leading-none outline-none",
        // Base UI highlights on both hover and keyboard focus, so one rule covers both and they
        // cannot drift apart.
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        "data-disabled:pointer-events-none data-disabled:opacity-40",
        "[&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      data-slot="context-menu-item"
      disabled={disabled}
      {...props}
    />
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: ContextMenuPrimitive.Separator.Props): React.ReactElement {
  return (
    <ContextMenuPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      data-slot="context-menu-separator"
      {...props}
    />
  );
}

export function ContextMenuLabel({
  className,
  ...props
}: ContextMenuPrimitive.GroupLabel.Props): React.ReactElement {
  return (
    <ContextMenuPrimitive.GroupLabel
      className={cn("px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground", className)}
      data-slot="context-menu-label"
      {...props}
    />
  );
}
