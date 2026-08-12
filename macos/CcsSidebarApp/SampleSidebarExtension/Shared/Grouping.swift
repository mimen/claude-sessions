import Foundation

/// Arranging rows into the groups the header asked for.
///
/// Grouping is done here rather than on the server because it is a view question: the same rows
/// answer "what needs me" and "what am I doing in this project" differently, and the server should
/// not have to know which one is on screen.
public enum Grouping {
    /// Section order for status grouping, taken from the web sidebar so both read alike.
    static let statusOrder = [
        "needs-you", "working", "ready", "other", "incognito", "recent", "saved", "completed",
    ]

    public static func group(
        rows: [SidebarRow],
        by mode: GroupingMode,
        now: Date = Date()
    ) -> [(name: String, rows: [SidebarRow])] {
        switch mode {
        case .status:
            return ordered(rows, keyed: { $0.section ?? "other" }, order: statusOrder, title: statusTitle)
        case .project:
            return ordered(rows, keyed: { $0.directory ?? "No project" }, order: nil, title: { $0 })
        case .category:
            return ordered(
                rows,
                keyed: { $0.category?.compactLabel ?? "Uncategorized" },
                order: nil,
                title: { $0 }
            )
        case .recent:
            // A flat list: recency is already the sort, so a band per day would only interrupt it.
            return rows.isEmpty ? [] : [("All", rows)]
        }
    }

    private static func ordered(
        _ rows: [SidebarRow],
        keyed key: (SidebarRow) -> String,
        order: [String]?,
        title: (String) -> String
    ) -> [(name: String, rows: [SidebarRow])] {
        var grouped: [String: [SidebarRow]] = [:]
        var appearance: [String] = []
        for row in rows {
            let bucket = key(row)
            if grouped[bucket] == nil { appearance.append(bucket) }
            grouped[bucket, default: []].append(row)
        }
        // A fixed order where one exists, so priority does not depend on which row sorted first;
        // otherwise the order the rows arrived in, which is already the server's ranking.
        let keys: [String]
        if let order {
            let unknown = appearance.filter { !order.contains($0) }.sorted()
            keys = order + unknown
        } else {
            keys = appearance
        }
        return keys.compactMap { key in
            guard let bucket = grouped[key], !bucket.isEmpty else { return nil }
            return (title(key), bucket)
        }
    }

    static func statusTitle(_ key: String) -> String {
        switch key {
        case "needs-you": return "Needs you"
        case "working": return "Working"
        case "ready": return "Ready"
        case "other": return "Other tabs"
        case "incognito": return "Incognito"
        case "recent": return "Recent"
        case "saved": return "Saved"
        case "completed": return "Done"
        default: return key.capitalized
        }
    }
}

public extension SidebarRow {
    /// Matches the filter against everything a person might type: name, project, category, model.
    func matches(_ query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return true }
        let haystack = [name, directory, category?.compactLabel, model?.label, worktree]
            .compactMap { $0?.lowercased() }
        return haystack.contains { $0.contains(needle) }
    }
}
