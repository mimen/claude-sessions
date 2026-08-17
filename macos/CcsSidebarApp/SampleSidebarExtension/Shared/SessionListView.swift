import SwiftUI

/// The sidebar's list, grouped the way the server already grouped it.
///
/// Sections come from each row's `section`, in first-appearance order, because the server has
/// already sorted the rows into the order it wants them read. Re-sorting here would be a second
/// opinion about priority, and the two would drift.
@MainActor
public struct SessionListView: View {
    private let rows: [SidebarRow]
    private let actions: RowActions
    private let selectedId: String?
    private let grouping: GroupingMode
    private let layouts: RowLayouts
    private let port: Int
    private let clusterFirst: Bool
    private let truncated: Bool
    private let clock: WorkingClock
    private let jumpLabels: [String: String]
    private let onJump: (Int) -> Void
    @State private var collapsed: Set<String> = []
    /// The one row the pointer is in, owned here rather than as per-row state.
    ///
    /// Per-row `@State` latched: a row that scrolled or reordered away under a stationary pointer
    /// never received its exit event, so it stayed painted as hovered until its view was destroyed
    /// — which is why closing and reopening the sidebar "fixed" rows stuck in the open state. One
    /// owner makes a second hovered row structurally impossible, and a stale id simply stops
    /// matching once the row list changes.
    @State private var hoveredId: String?

    public init(
        rows: [SidebarRow],
        actions: RowActions,
        selectedId: String? = nil,
        grouping: GroupingMode = .status,
        layouts: RowLayouts = RowLayouts(),
        port: Int = 8788,
        clusterFirst: Bool = false,
        truncated: Bool = false,
        clock: WorkingClock,
        jumpLabels: [String: String] = [:],
        onJump: @escaping (Int) -> Void = { _ in }
    ) {
        self.rows = rows
        self.actions = actions
        self.selectedId = selectedId
        self.grouping = grouping
        self.layouts = layouts
        self.port = port
        self.clusterFirst = clusterFirst
        self.truncated = truncated
        self.clock = clock
        self.jumpLabels = jumpLabels
        self.onJump = onJump
    }

    private var sections: [(name: String, rows: [SidebarRow])] {
        Grouping.group(rows: rows, by: grouping, clusterFirst: clusterFirst)
    }

    public var body: some View {
        // @Observable only re-evaluates views that read a changing property, and until this read
        // existed nothing read the tick — so elapsed labels froze between snapshots and only moved
        // when a poll happened to repaint the list.
        let _ = clock.tick
        listBody(now: Date())
            .onChange(of: rows.map(\.id)) { _, _ in
                // Membership or order changed under the pointer; whatever was hovered may no
                // longer be where the pointer is. Resetting beats guessing.
                hoveredId = nil
            }
    }

    private func listBody(now: Date) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(sections, id: \.name) { section in
                    Section {
                        ForEach(collapsed.contains(section.name) ? [] : section.rows) { row in
                            SessionRowView(
                                row: row,
                                age: RelativeAge.format(row.lastActivityAt, now: now),
                                actions: actions,
                                layout: layouts.layout(for: row),
                                port: port,
                                workingFor: clock.elapsed(for: row),
                                jumpLabel: jumpLabels[row.id],
                                isHovered: hoveredId == row.id,
                                onHoverChange: { inside in
                                    if inside { hoveredId = row.id }
                                    else if hoveredId == row.id { hoveredId = nil }
                                }
                            )
                            .id(row.id)
                        }
                    } header: {
                        HStack(spacing: 4) {
                            Image(systemName: collapsed.contains(section.name) ? "chevron.right" : "chevron.down")
                                .font(.system(size: 8, weight: .semibold))
                            Text(section.name.uppercased())
                                .font(.system(size: 10, weight: .semibold))
                                .tracking(0.8)
                            Spacer()
                            Text("\(section.rows.count)")
                                .font(.system(size: 10))
                                .monospacedDigit()
                        }
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.top, 10)
                        .padding(.bottom, 2)
                        .contentShape(Rectangle())
                        // Shelving a section is a standing choice about how much you want to see,
                        // so its count stays visible while its rows are away.
                        .onTapGesture {
                            if collapsed.contains(section.name) { collapsed.remove(section.name) }
                            else { collapsed.insert(section.name) }
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
