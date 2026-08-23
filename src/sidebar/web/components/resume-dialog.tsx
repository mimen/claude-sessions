import type React from "react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export function ResumeDialog({ phase, name, onCancel, onConfirm }: {
  readonly phase: "completed" | "t3";
  readonly name: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

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
          <Button onClick={onConfirm} size="sm">
            {completed ? "Resume" : "Resume anyway"}
          </Button>
        </div>
      </div>
    </div>
  );
}
