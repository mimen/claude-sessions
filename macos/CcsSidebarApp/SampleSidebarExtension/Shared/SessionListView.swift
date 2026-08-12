import SwiftUI

/// The sidebar's list, grouped the way the server already grouped it.
///
/// Sections come from each row's `section`, in first-appearance order, because the server has
/// already sorted the rows into the order it wants them read. Re-sorting here would be a second
/// opinion about priority, and the two would drift.
@MainActor
public struct SessionListView: View {
    private let rows: [SidebarRow]
    private let now: Date
    private let actions: RowActions
    private let selectedId: String?
    private let grouping: GroupingMode
    private let layouts: RowLayouts
    private let port: Int
    @State private var collapsed: Set<String> = []

    public init(
        rows: [SidebarRow],
        actions: RowActions,
        now: Date = Date(),
        selectedId: String? = nil,
        grouping: GroupingMode = .status,
        layouts: RowLayouts = RowLayouts(),
        port: Int = 8788
    ) {
        self.rows = rows
        self.actions = actions
        self.now = now
        self.selectedId = selectedId
        self.grouping = grouping
        self.layouts = layouts
        self.port = port
    }

    private var sections: [(name: String, rows: [SidebarRow])] {
        Grouping.group(rows: rows, by: grouping)
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6, pinnedViews: [.sectionHeaders]) {
                ForEach(sections, id: \.name) { section in
                    Section {
                        ForEach(collapsed.contains(section.name) ? [] : section.rows) { row in
                            SessionRowView(
                                row: row,
                                age: RelativeAge.format(row.lastActivityAt, now: now),
                                actions: actions,
                                isSelected: row.id == selectedId,
                                layout: layouts.layout(for: row),
                                port: port
                            )
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
                        .padding(.vertical, 4)
                        .background(.background)
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
