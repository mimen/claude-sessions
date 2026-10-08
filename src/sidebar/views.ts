/**
 * Which list the sidebar is showing, and which lifecycle that list reads.
 *
 * Kept free of imports because the browser bundle needs `lifecycleForView` at runtime, and
 * importing it from projection.ts pulls the catalogue and Node built-ins into the page.
 */
export type SidebarLifecycle = "active" | "completed" | "saved";
export type SidebarScope = SidebarLifecycle;
export type SidebarInclude = SidebarLifecycle | "t3";

/**
 * What the list is showing.
 *
 * `triage` is not a lifecycle -- a session is never "in triage" -- it is the active list filtered
 * to rows whose enrichment verdict still contradicts where they sit. Keeping it out of
 * `SidebarLifecycle` means no lifecycle-typed value can ever be handed one, and the catalogue
 * never has to answer a question it has no column for.
 */
export type SidebarView = SidebarScope | "triage" | "incognito" | "t3";

export const SIDEBAR_VIEWS: readonly SidebarView[] =
  ["active", "saved", "t3", "completed", "triage", "incognito"];

/**
 * The lifecycle a view browses. Triage reads the active list, then filters it.
 *
 * Incognito reads the active list for the same reason and one more: a marked session is excluded
 * from the catalogue's per-lifecycle id lists entirely, so there is no id set to address it by.
 * The rows it wants are live ones, and live rows come from cmux rather than from those lists.
 */
export function lifecycleForView(view: SidebarView): SidebarScope {
  return view === "triage" || view === "incognito" || view === "t3" ? "active" : view;
}
