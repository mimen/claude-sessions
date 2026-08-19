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
/// Everything this view paints is derived, never accumulated. Rows are whatever the last snapshot
/// said. Hover is recomputed from where the pointer actually is — `PointerWatch` polls the window
/// server — against row frames measured this layout pass, so no dropped AppKit event can latch a
/// row. Focus is the snapshot's word, briefly overridden by the user's own click. Recreating this
/// view yields the same screen as one that has run for a day, which is the property the old
/// event-accumulated hover state broke.
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
    private let truncated: Bool
    private let clock: WorkingClock
    private let jumpLabels: [String: String]
    private let onJump: (Int) -> Void
    /// Which groups are shelved, seeded from the stored choice: a section you closed should still
    /// be closed after cmux rebuilds the panel, which it does several times a day.
    @State private var collapsed: Set<String> = Preferences.collapsedGroups
    /// Where the pointer is over the list, in the list's coordinate space; nil when outside.
    @State private var pointer: CGPoint?
    /// Each materialised row's frame in the list's coordinate space, refreshed by layout.
    @State private var rowFrames: [String: CGRect] = [:]

    private nonisolated static let space = "ccs-session-list"

    public init(
        rows: [SidebarRow],
        actions: RowActions,
        focusOverride: FocusOverride? = nil,
        grouping: GroupingMode = .status,
        layouts: RowLayouts = RowLayouts(),
        port: Int = SidebarServer.defaultPort,
        clusterFirst: Bool = false,
        clusterSplit: ClusterSplit = .none,
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
        self.truncated = truncated
        self.clock = clock
        self.jumpLabels = jumpLabels
        self.onJump = onJump
    }

    private var sections: [SidebarGroup] {
        Grouping.group(rows: rows, by: grouping, clusterFirst: clusterFirst, clusterSplit: clusterSplit)
    }

    /// The row under the pointer right now — a lookup, not a stored answer. Iterates `rows`
    /// rather than the frame dictionary so a stale frame left by a departed row can never win.
    private var hoveredId: String? {
        guard let pointer else { return nil }
        return rows.first { rowFrames[$0.id]?.contains(pointer) == true }?.id
    }

    public var body: some View {
        // @Observable only re-evaluates views that read a changing property, and until this read
        // existed nothing read the tick — so elapsed labels froze between snapshots and only moved
        // when a poll happened to repaint the list. The tick also retires an expired focus
        // override within a second of its deadline.
        let _ = clock.tick
        listBody(now: Date())
            .onChange(of: rows.map(\.id)) { _, ids in
                // Frames belong to rows; a departed row's frame must not linger to shadow
                // whatever row the layout puts in its place.
                let live = Set(ids)
                rowFrames = rowFrames.filter { live.contains($0.key) }
            }
    }

    private func listBody(now: Date) -> some View {
        // While a click's claim is live, it is the whole story: the server's previous focus is
        // suppressed rather than letting two rows light up.
        let override = focusOverride.flatMap { candidate in
            candidate.active(now: now) && rows.contains(where: { $0.id == candidate.id })
                ? candidate.id : nil
        }
        let hovered = hoveredId
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(sections) { section in
                    Section {
                        if !collapsed.contains(section.key) {
                            ForEach(section.rows) { row in
                                rowView(row, now: now, hovered: hovered, override: override)
                            }
                            // Nested bands come after the group's own rows: a cluster's core
                            // identities are the way in, and its events hang below them.
                            ForEach(section.children) { child in
                                sectionHeader(child, depth: 1)
                                if !collapsed.contains(child.key) {
                                    ForEach(child.rows) { row in
                                        rowView(row, now: now, hovered: hovered, override: override)
                                            .padding(.leading, 8)
                                    }
                                }
                            }
                        }
                    } header: {
                        sectionHeader(section)
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
        .coordinateSpace(name: Self.space)
        // The overlay shares the ScrollView's bounds, so a point in its flipped view coordinates
        // is a point in the named space the row frames were measured in.
        .overlay(PointerWatch { pointer = $0 })
    }

    private func rowView(
        _ row: SidebarRow,
        now: Date,
        hovered: String?,
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
            isHovered: hovered == row.id,
            isFocused: override.map { $0 == row.id }
        )
        .onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .named(Self.space))
        } action: { frame in
            rowFrames[row.id] = frame
        }
        .id(row.id)
    }

    private func sectionHeader(_ section: SidebarGroup, depth: Int = 0) -> some View {
        // A Button, not `.onTapGesture`: the tap gesture hit-tests whatever sits under the pointer
        // when the click lands, and collapsing a band slides the next one up into that exact spot
        // — so one click walked down the list shelving every section it uncovered. A button binds
        // press and release to the same view, so a header that arrives under a stationary cursor
        // mid-click is never the one that fires.
        Button {
            if collapsed.contains(section.key) { collapsed.remove(section.key) }
            else { collapsed.insert(section.key) }
            // Shelving a section is a standing choice about how much you want to see, so it
            // outlives the panel cmux rebuilds several times a day.
            Preferences.collapsedGroups = collapsed
        } label: {
            HStack(spacing: 4) {
                Image(systemName: collapsed.contains(section.key) ? "chevron.right" : "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                Text(section.name.uppercased())
                    .font(.system(size: depth == 0 ? 10 : 9, weight: .semibold))
                    .tracking(0.8)
                Spacer()
                // The count covers everything the group holds, nested rows included, so a collapsed
                // cluster still says how much is inside it.
                Text("\(section.totalRows)")
                    .font(.system(size: 10))
                    .monospacedDigit()
            }
            .foregroundStyle(depth == 0 ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tertiary))
            .padding(.leading, CGFloat(10 + depth * 10))
            .padding(.trailing, 10)
            .padding(.top, depth == 0 ? 10 : 6)
            .padding(.bottom, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
