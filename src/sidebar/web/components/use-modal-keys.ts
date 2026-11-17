import { useEffect, type RefObject } from "react";

/** Escape cancels; Tab and Shift+Tab cycle through the dialog's own controls instead of the page behind it. */
export function useModalKeys(dialogRef: RefObject<HTMLElement | null>, onCancel: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      const dialog = dialogRef.current;
      if (event.key !== "Tab" || !dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")];
      const first = controls[0];
      const last = controls.at(-1);
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
      } else if (!dialog.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dialogRef, onCancel]);
}
