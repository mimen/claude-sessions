/**
 * Which lifecycle the queue is showing.
 *
 * Active is the working view; Saved holds resumable context and Done holds concluded work. Same
 * native-select treatment as the arrangement control so the two read as a pair.
 */
import type React from "react";
import type { SidebarView } from "../../projection.ts";
import { ChevronIcon } from "./icons.tsx";

/**
 * Triage sits next to Active because it is the same list, narrowed: the sessions whose verdict
 * still contradicts where they sit. Incognito is the same shape -- the active list narrowed to the
 * marked sessions that are open right now. Saved and Done remain reachable in the same control,
 * because it is meant to be a complete account of what the list can show, and a view that existed
 * but could not be named from here would make it a partial one.
 */
const SCOPES: ReadonlyArray<{ readonly value: SidebarView; readonly label: string }> = [
  { value: "active", label: "Active" },
  { value: "triage", label: "Triage" },
  { value: "incognito", label: "Incognito" },
  { value: "saved", label: "Saved" },
  { value: "completed", label: "Done" },
];

export function ScopeSelect({ value, onChange }: {
  readonly value: SidebarView;
  readonly onChange: (view: SidebarView) => void;
}): React.ReactElement {
  const label = SCOPES.find((scope) => scope.value === value)?.label ?? "Active";
  return (
    <div className="relative shrink-0">
      <div className="pointer-events-none flex h-7 items-center gap-1 rounded-md border border-input bg-transparent px-2 text-[11px] text-muted-foreground">
        {label}
        <ChevronIcon className="size-3 opacity-60" />
      </div>
      <select
        aria-label="Which sessions to show"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        onChange={(event) => onChange(event.target.value as SidebarView)}
        value={value}
      >
        {SCOPES.map((scope) => (
          <option key={scope.value} value={scope.value}>{scope.label}</option>
        ))}
      </select>
    </div>
  );
}
