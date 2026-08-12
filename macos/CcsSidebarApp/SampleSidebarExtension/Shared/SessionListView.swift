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

    public init(
        rows: [SidebarRow],
        actions: RowActions,
        now: Date = Date(),
        selectedId: String? = nil,
        grouping: GroupingMode = .status,
        layouts: RowLayouts = RowLayouts()
    ) {
        self.rows = rows
        self.actions = actions
        self.now = now
        self.selectedId = selectedId
        self.grouping = grouping
        self.layouts = layouts
    }

    private var sections: [(name: String, rows: [SidebarRow])] {
        Grouping.group(rows: rows, by: grouping)
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6, pinnedViews: [.sectionHeaders]) {
                ForEach(sections, id: \.name) { section in
                    Section {
                        ForEach(section.rows) { row in
                            SessionRowView(
                                row: row,
                                age: RelativeAge.format(row.lastActivityAt, now: now),
                                actions: actions,
                                isSelected: row.id == selectedId,
                                layout: layouts.layout(for: row)
                            )
                        }
                    } header: {
                        HStack {
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
