/**
 * Vendored from Kibo UI Status.
 * Source: https://github.com/shadcnblocks/kibo/blob/982f844377dcb23b60dcd29e9f646d1a85891564/packages/status/index.tsx
 */
import type React from "react";
import type { ComponentProps, HTMLAttributes } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusProps = ComponentProps<typeof Badge> & {
  readonly status: "online" | "offline" | "maintenance" | "degraded";
};

export function Status({ className, status, ...props }: StatusProps): React.ReactElement {
  return (
    <Badge
      className={cn("flex items-center gap-2", "group", status, className)}
      variant="secondary"
      {...props}
    />
  );
}

export type StatusIndicatorProps = HTMLAttributes<HTMLSpanElement>;

export function StatusIndicator({
  className,
  ...props
}: StatusIndicatorProps): React.ReactElement {
  return (
    <span className={cn("relative flex h-2 w-2", className)} {...props}>
      <span
        className={cn(
          "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
          "group-[.online]:bg-emerald-500",
          "group-[.offline]:bg-red-500",
          "group-[.maintenance]:bg-blue-500",
          "group-[.degraded]:bg-amber-500",
        )}
      />
      <span
        className={cn(
          "relative inline-flex h-2 w-2 rounded-full",
          "group-[.online]:bg-emerald-500",
          "group-[.offline]:bg-red-500",
          "group-[.maintenance]:bg-blue-500",
          "group-[.degraded]:bg-amber-500",
        )}
      />
    </span>
  );
}

export type StatusLabelProps = HTMLAttributes<HTMLSpanElement>;

export function StatusLabel({
  className,
  children,
  ...props
}: StatusLabelProps): React.ReactElement {
  return (
    <span className={cn("text-muted-foreground", className)} {...props}>
      {children ?? (
        <>
          <span className="hidden group-[.online]:block">Online</span>
          <span className="hidden group-[.offline]:block">Offline</span>
          <span className="hidden group-[.maintenance]:block">Maintenance</span>
          <span className="hidden group-[.degraded]:block">Degraded</span>
        </>
      )}
    </span>
  );
}
