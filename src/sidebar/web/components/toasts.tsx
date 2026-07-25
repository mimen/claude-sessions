/**
 * Transient messages, floated over the list.
 *
 * Nothing here may take layout space at the top: a notice that pushes the queue down is worse
 * than the problem it reports. Ongoing conditions stay until they clear; one-off failures fade.
 */
import type React from "react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

export interface Toast {
  readonly id: string;
  readonly message: string;
  /** Conditions persist while true; events dismiss themselves. */
  readonly persistent: boolean;
}

const DISMISS_AFTER_MS = 6_000;

function ToastItem({ toast, onDismiss }: {
  toast: Toast;
  onDismiss: (id: string) => void;
}): React.ReactElement {
  useEffect(() => {
    if (toast.persistent) return;
    const timer = setTimeout(() => onDismiss(toast.id), DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [onDismiss, toast.id, toast.persistent]);

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px] shadow-lg",
        "border-[color:var(--warning)]/40 bg-popover text-popover-foreground",
      )}
      role={toast.persistent ? "status" : "alert"}
    >
      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-[color:var(--warning)]" />
      <span className="flex-1">{toast.message}</span>
      {toast.persistent ? null : (
        <button
          aria-label="Dismiss"
          className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
          onClick={() => onDismiss(toast.id)}
          type="button"
        >
          ×
        </button>
      )}
    </div>
  );
}

export function Toasts({ toasts, onDismiss }: {
  toasts: readonly Toast[];
  onDismiss: (id: string) => void;
}): React.ReactElement | null {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-2 z-50 flex flex-col gap-1.5">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} onDismiss={onDismiss} toast={toast} />
      ))}
    </div>
  );
}
