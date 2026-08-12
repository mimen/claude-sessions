import SwiftUI

/// The sidebar's list, grouped the way the server already grouped it.
///
/// Sections come from each row's `section`, in first-appearance order, because the server has
/// already sorted the rows into the order it wants them read. Re-sorting here would be a second
/// opinion about priority, and the two would drift.
public struct SessionListView: View {
    private let rows: [SidebarRow]
    private let now: Date

    public init(rows: [SidebarRow], now: Date = Date()) {
        self.rows = rows
        self.now = now
    }

    /// Section order, fixed rather than derived from the response.
    ///
    /// Taken from the web sidebar so both read the same: what is asking for you first, finished
    /// work last. First-appearance order looked equivalent and was not — it put `working` above
    /// `needs-you` whenever a running session happened to sort first.
    private static let order: [String] = [
        "needs-you", "working", "ready", "other", "incognito", "recent", "saved", "completed",
    ]

    private var sections: [(name: String, rows: [SidebarRow])] {
        var grouped: [String: [SidebarRow]] = [:]
        for row in rows { grouped[row.section ?? "other", default: []].append(row) }
        // Anything the server introduces that this list has not heard of still shows, after the
        // known sections rather than silently dropped.
        let unknown = grouped.keys.filter { !Self.order.contains($0) }.sorted()
        return (Self.order + unknown).compactMap { key in
            guard let rows = grouped[key], !rows.isEmpty else { return nil }
            return (key, rows)
        }
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6, pinnedViews: [.sectionHeaders]) {
                ForEach(sections, id: \.name) { section in
                    Section {
                        ForEach(section.rows) { row in
                            SessionRowView(row: row, age: RelativeAge.format(row.lastActivityAt, now: now))
                        }
                    } header: {
                        HStack {
                            Text(sectionTitle(section.name).uppercased())
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

    private func sectionTitle(_ key: String) -> String {
        switch key {
        case "needs-you": return "Needs you"
        case "working": return "Working"
        case "ready": return "Ready"
        case "recent": return "Recent"
        case "other": return "Other tabs"
        case "incognito": return "Incognito"
        case "saved": return "Saved"
        case "completed": return "Done"
        default: return key
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
