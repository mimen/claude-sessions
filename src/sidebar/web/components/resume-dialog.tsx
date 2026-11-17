import type React from "react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useModalKeys } from "./use-modal-keys.ts";

export function ResumeDialog({ phase, name, onCancel, onConfirm }: {
  readonly phase: "completed" | "t3";
  readonly name: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.ReactElement {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Opened from a row or with Enter, the dialog takes focus so the keyboard reaches its buttons
  // instead of the list behind it, and gives focus back to where it came from when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useModalKeys(dialogRef, onCancel);

  const completed = phase === "completed";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
      role="presentation"
    >
      <div
        aria-labelledby="resume-dialog-title"
        aria-modal="true"
        className="w-full max-w-sm rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg"
        ref={dialogRef}
        role="dialog"
      >
        <h2 className="text-sm font-medium" id="resume-dialog-title">
          {completed ? "Resume this session?" : "Resume this T3 Code session directly?"}
        </h2>
        <p className="mt-1 truncate text-[12px] text-muted-foreground" title={name}>{name}</p>
        <p className="mt-3 text-[12px] leading-[1.5]">
          {completed
            ? "This session is marked done. Resuming moves it back to Active and reopens it in cmux."
            : "This session is associated with T3 Code. Resuming here opens another Claude Code runtime; the T3 tag will remain."}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel} size="sm" variant="outline">Cancel</Button>
          <Button onClick={onConfirm} ref={confirmRef} size="sm">
            {completed ? "Resume" : "Resume anyway"}
          </Button>
        </div>
      </div>
    </div>
  );
}
