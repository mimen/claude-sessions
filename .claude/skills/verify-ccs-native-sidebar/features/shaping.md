# Shaping the list

The header strip decides what the queue shows and how densely: which scope, a text filter, how rows
are grouped, how tall a row is, and whether fleets are lifted out into their own groups. Every one
of these choices outlives a relaunch, because cmux rebuilds the panel several times a day.

## Sub-features

- `shape-scope` picks Active, Saved, T3 Code, Done or Triage.
- `shape-filter` narrows to matching rows and, while typing, searches every lifecycle and T3.
- `shape-grouping` arranges By status, By project, By category or Most recent.
- `shape-layout` chooses a row layout — Wide title, Status beside title, Three lines — separately
  for open and closed sessions.
- `shape-clusters` lifts fleets into their own groups, split by work item or by role and phase.
- `shape-shelve` collapses one group; `shape-visibility` shows only its open sessions.
- `shape-persist` every choice above survives a panel rebuild.

## How to get to it (user POV)

- The header strip at the top of the panel: filter field, scope picker, grouping picker, the
  `Clusters` toggle, and the display-options menu holding the cluster split and both row layouts.
- A group header: shelve it, or set what it shows.

## Driving it with the CCS harnesses

Preconditions: server up; the extension installed if you are driving the live panel.

- **Scope changes what is requested, not just what is drawn.** The client asks for
  `scope=<scope>` and adds `include=saved` on Active, `include=active,saved,completed,t3` while
  searching. Compare with the server:
  `curl -s 'http://127.0.0.1:8787/api/snapshot?limit=2000&scope=saved&include=active,saved,completed,t3'`.
  Rows the panel shows under a scope must be rows that query returns.
- **Filter.** Type in the filter field, then screenshot. Only matching rows remain, and while the
  field is non-empty the request widens to every lifecycle — a closed session matching the text
  appears even from the Active scope.
- **Grouping and layout.** Set each in turn and screenshot. `swift test` covers what the layouts
  compute; the picture is what proves they are reachable and distinct.
- **Layouts render.** Both layouts can be seen without the panel: the renderer draws
  `SessionRowView` directly, so a layout change shows up in `/tmp/*.png` immediately.
- **Persistence.** Choices are `UserDefaults` keys inside the extension's own container:
  `defaults read ~/Library/Containers/com.milad.ccs.sidebar.Extension/Data/Library/Preferences/com.milad.ccs.sidebar.Extension.plist | grep 'ccs\.'`.
  Expect `ccs.scope`, `ccs.grouping`, `ccs.clusterFirst`, `ccs.clusterSplit`, `ccs.collapsedGroups`,
  `ccs.groupVisibility`. Change one in the panel, re-read the plist, then make cmux rebuild the
  panel (switch provider away and back) and confirm the choice returned.
- **Clusters.** With `Clusters` on, a fleet leaves the ordinary sections and appears under its own
  header; the split (`none`, work item, role and phase) decides how it is cut. `swift test` covers
  `ClusterSplitTests`; a screenshot proves the header and parts exist.
- **Per-group visibility.** `RowVisibilityTests` covers the rule; live, set a fleet group to open
  sessions only and confirm the finished workers disappear from that group and no other.

## Gotchas

- A query suspends per-group view choices — shelving and visibility do not apply while the filter
  is narrowing the list. A collapsed group that reopens during a search is correct.
- Scope is a stored preference, so the panel does not necessarily open on Active. Read
  `ccs.scope` before concluding a row is missing.
- Preferences live in the extension's sandbox container, not in `com.cmuxterm.app`. Reading the
  cmux domain will show none of this.
- Cluster splitting only changes fleets, and only while `Clusters` is on; a solo session is
  unaffected, which looks like a broken toggle if there is no fleet in view.
- The renderer ignores the header strip entirely — it draws rows, not the panel. Scope, filter and
  grouping are only observable against the server or in a live screenshot.
