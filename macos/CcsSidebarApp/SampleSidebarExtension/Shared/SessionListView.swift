import SwiftUI

/// A click's immediate claim on the focus highlight, held until the server confirms or a few
/// seconds pass.
///
/// Painting focus only from the snapshot meant a click waited on the whole round trip — POST,
/// cmux switching, the server noticing, the client refetching — and any hiccup in that chain read
/// as "I clicked and nothing highlighted". The click itself is the best predictor of where focus
/// is about to be, so the list paints it at once. The override is deliberately short-lived: the
/// next snapshot confirming it retires it, and if the open failed, expiry hands the highlight
/// back to server truth instead of leaving an optimistic lie on screen.
public struct FocusOverride: Equatable, Sendable {
    public let id: String
    public let at: Date

    public init(id: String, at: Date = Date()) {
        self.id = id
        self.at = at
    }

    /// How long a click's claim outlives the click while unconfirmed.
    public static let lifetime: TimeInterval = 4

    public func active(now: Date) -> Bool {
        now.timeIntervalSince(at) < Self.lifetime
    }
}

/// The sidebar's list, grouped the way the server already grouped it.
///
/// Sections come from each row's `section`, in first-appearance order, because the server has
/// already sorted the rows into the order it wants them read. Re-sorting here would be a second
/// opinion about priority, and the two would drift.
///
/// Rows are whatever the last snapshot said. Focus is the snapshot's word, briefly overridden by
/// the user's own click.
///
/// Hover is an AppKit tracking area per row — see `HoverTracker`.
@MainActor
public struct SessionListView: View {
    private let rows: [SidebarRow]
    private let actions: RowActions
    private let focusOverride: FocusOverride?
    private let grouping: GroupingMode
    private let layouts: RowLayouts
    private let port: Int
    private let clusterFirst: Bool
    private let clusterSplit: ClusterSplit
    /// Whether a query is narrowing the list, which suspends every per-group view choice.
    private let searching: Bool
    private let truncated: Bool
    private let clock: WorkingClock
    private let jumpLabels: [String: String]
    private let onJump: (Int) -> Void
    /// Which groups are shelved, seeded from the stored choice: a section you closed should still
    /// be closed after cmux rebuilds the panel, which it does several times a day.
    @State private var collapsed: Set<String> = Preferences.collapsedGroups
    /// Which groups are filtered to their open sessions. Same seeding, separate choice.
    @State private var visibility: [String: RowVisibility] = Preferences.groupVisibility
    /// The row AppKit says the pointer is inside, or nil.
    @State private var hoveredRowId: String?
    /// Reports what hover is doing, for the footer readout.
    private let probe: HoverProbe

    public init(
        rows: [SidebarRow],
        actions: RowActions,
        focusOverride: FocusOverride? = nil,
        grouping: GroupingMode = .status,
        layouts: RowLayouts = RowLayouts(),
        port: Int = SidebarServer.defaultPort,
        clusterFirst: Bool = false,
        clusterSplit: ClusterSplit = .none,
        searching: Bool = false,
        probe: HoverProbe,
        truncated: Bool = false,
        clock: WorkingClock,
        jumpLabels: [String: String] = [:],
        onJump: @escaping (Int) -> Void = { _ in }
    ) {
        self.rows = rows
        self.actions = actions
        self.focusOverride = focusOverride
        self.grouping = grouping
        self.layouts = layouts
        self.port = port
        self.clusterFirst = clusterFirst
        self.clusterSplit = clusterSplit
        self.searching = searching
        self.probe = probe
        self.truncated = truncated
        self.clock = clock
        self.jumpLabels = jumpLabels
        self.onJump = onJump
    }

    private var sections: [SidebarGroup] {
        Grouping.group(rows: rows, by: grouping, clusterFirst: clusterFirst, clusterSplit: clusterSplit)
    }

    public var body: some View {
        // @Observable only re-evaluates views that read a changing property, and until this read
        // existed nothing read the tick — so elapsed labels froze between snapshots and only moved
        // when a poll happened to repaint the list. The tick also retires an expired focus
        // override within a second of its deadline.
        let _ = clock.tick
        listBody(now: Date())
            .onChange(of: rows.map(\.id)) { _, ids in
                // A row that leaves the list cannot still be the hovered one.
                if let hoveredRowId, !ids.contains(hoveredRowId) { self.hoveredRowId = nil }
            }
            .onChange(of: hoveredRowId) { _, id in
                probe.hovered = id.flatMap { hoveredId in rows.first { $0.id == hoveredId }?.name }
            }
    }

    private func listBody(now: Date) -> some View {
        // While a click's claim is live, it is the whole story: the server's previous focus is
        // suppressed rather than letting two rows light up.
        let override = focusOverride.flatMap { candidate in
            candidate.active(now: now) && rows.contains(where: { $0.id == candidate.id })
                ? candidate.id : nil
        }
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                // Headers are emitted as ordinary rows rather than through `Section(header:)`:
                // a Section whose content is empty takes its header down with it, so a collapsed
                // group vanished from the list entirely instead of leaving the header you need in
                // order to open it again.
                ForEach(sections) { section in
                    let shown = shows(section)
                    sectionHeader(section)
                    if !isCollapsed(section) {
                        ForEach(shown.filter(section.rows)) { row in
                            rowView(row, now: now, override: override)
                        }
                        // Nested bands come after the group's own rows: a cluster's core
                        // identities are the way in, and its events hang below them.
                        ForEach(section.children) { child in
                            // Filtering a cluster means the whole cluster, its events included —
                            // unless that event has been given its own answer, which outranks
                            // what it inherits.
                            let childShown = shows(child, inherited: shown)
                            let childRows = childShown.filter(child.rows)
                            // An event with nothing running is not worth a header while its
                            // cluster is filtered: dropping it is the point of filtering.
                            if !(childRows.isEmpty && childShown == .openOnly) {
                                sectionHeader(child, depth: 1, inherited: shown)
                                if !isCollapsed(child) {
                                    ForEach(childRows) { row in
                                        rowView(row, now: now, override: override)
                                            .padding(.leading, 8)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(8)
            .background(OverlayScrollers().frame(width: 0, height: 0))

            if truncated {
                // A list that silently stopped is worse than one that says it did.
                Text("More sessions exist than this view will show.")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .padding(.bottom, 10)
            }
        }

    }

    private func rowView(
        _ row: SidebarRow,
        now: Date,
        override: String?
    ) -> some View {
        SessionRowView(
            row: row,
            age: RelativeAge.format(row.lastActivityAt, now: now),
            actions: actions,
            layout: layouts.layout(for: row),
            port: port,
            workingFor: clock.elapsed(for: row),
            jumpLabel: jumpLabels[row.id],
            // The row answers this for itself; see `trackedHovering` in SessionRowView.
            isHovered: false,
            isFocused: override.map { $0 == row.id },
            onHoverChanged: { inside in
                if inside {
                    probe.noteEntered()
                    hoveredRowId = row.id
                } else {
                    probe.noteExited()
                    if hoveredRowId == row.id { hoveredRowId = nil }
                }
            }
        )
        .id(row.id)
    }

    /// What a group shows: its own answer if it has one, otherwise what it inherits from the
    /// cluster above it, otherwise everything.
    ///
    /// A query outranks all of it. Collapse and the open-sessions filter are choices about how to
    /// BROWSE; a search is a question, and answering it with a group that quietly holds the matches
    /// back is answering a different one. Searching a fleet you had shelved and filtered showed an
    /// empty list with the count sitting right there in the header.
    private func shows(_ section: SidebarGroup, inherited: RowVisibility? = nil) -> RowVisibility {
        searching ? .all : (visibility[section.key] ?? inherited ?? .all)
    }

    /// Whether this group is shelved right now — never while a query is narrowing the list.
    private func isCollapsed(_ section: SidebarGroup) -> Bool {
        !searching && collapsed.contains(section.key)
    }

    private func sectionHeader(
        _ section: SidebarGroup,
        depth: Int = 0,
        inherited: RowVisibility? = nil
    ) -> some View {
        let shown = shows(section, inherited: inherited)
        return HStack(spacing: 4) {
            // Two controls, because they are two independent choices about the same group: the
            // name shelves it, the mark filters it. A single control cycling through both could
            // not express "open sessions, group expanded".
            //
            // A Button, not `.onTapGesture`: the tap gesture hit-tests whatever sits under the
            // pointer when the click lands, and collapsing a band slides the next one up into that
            // exact spot — so one click walked down the list shelving every section it uncovered.
            // A button binds press and release to the same view, so a header that arrives under a
            // stationary cursor mid-click is never the one that fires.
            Button {
                if collapsed.contains(section.key) { collapsed.remove(section.key) }
                else { collapsed.insert(section.key) }
                // How much of a group you want to see is a standing choice, so it outlives the
                // panel cmux rebuilds several times a day.
                Preferences.collapsedGroups = collapsed
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: isCollapsed(section) ? "chevron.right" : "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                    Text(section.name.uppercased())
                        .font(.system(size: depth == 0 ? 10 : 9, weight: .semibold))
                        .tracking(0.8)
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                visibility[section.key] = shown.toggled
                Preferences.groupVisibility = visibility
            } label: {
                Image(systemName: shown.symbol).font(.system(size: 9))
            }
            .buttonStyle(.plain)
            .foregroundStyle(shown == .openOnly ? AnyShapeStyle(.secondary) : AnyShapeStyle(.quaternary))
            .help(shown.title)

            // The count covers everything the group holds, nested rows included, so a collapsed
            // cluster still says how much is inside it. While it is filtered the header says how
            // many of those are running, because that is the number the filter is about.
            Text(shown == .openOnly ? "\(section.openRows)/\(section.totalRows)" : "\(section.totalRows)")
                .font(.system(size: 10))
                .monospacedDigit()
        }
        .foregroundStyle(depth == 0 ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tertiary))
        .padding(.leading, CGFloat(10 + depth * 10))
        .padding(.trailing, 10)
        .padding(.top, depth == 0 ? 10 : 6)
        .padding(.bottom, 2)
    }
}
/// Coarse ages. The bands match the web sidebar's so the two read the same at a glance.
public enum RelativeAge {
    public static func format(_ epochMs: Double?, now: Date = Date()) -> String {
        guard let epochMs else { return "" }
        let seconds = now.timeIntervalSince1970 - epochMs / 1000
        if seconds < 90 { return "now" }
        if seconds < 3_600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600))h" }
        if seconds < 604_800 { return "\(Int(seconds / 86_400))d" }
        return "\(Int(seconds / 604_800))w"
    }
}
