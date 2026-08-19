import Foundation

/// One band of the list: a name, the rows directly under it, and any nested bands beneath.
///
/// A flat grouping produces groups with no children. Clusters produce one group per cluster whose
/// children are its events or roles, so the fleet reads as a thing with parts rather than as a run
/// of sibling headers that happen to share a prefix.
public struct SidebarGroup: Identifiable, Sendable {
    /// Stable across renders and unique among siblings; also the key collapse state is filed under.
    public let key: String
    public let name: String
    /// Rows belonging to this group itself — a cluster's core identities, or every row of a flat
    /// group.
    public let rows: [SidebarRow]
    public let children: [SidebarGroup]

    public var id: String { key }

    /// What the header counts: everything the group is responsible for, nested rows included.
    public var totalRows: Int { rows.count + children.reduce(0) { $0 + $1.totalRows } }
}

/// Arranging rows into the groups the header asked for.
///
/// Grouping is done here rather than on the server because it is a view question: the same rows
/// answer "what needs me" and "what am I doing in this project" differently, and the server should
/// not have to know which one is on screen.
public enum Grouping {
    /// Section order for status grouping, taken from the web sidebar so both read alike.
    /// The waiting states lead together: "needs you" and "ready" are both holding for a human,
    /// so they sit above "working", which is handled and only needs watching.
    static let statusOrder = [
        "needs-you", "ready", "working", "other", "incognito", "recent", "saved", "completed",
    ]

    public static func group(
        rows: [SidebarRow],
        by mode: GroupingMode,
        clusterFirst: Bool = false,
        clusterSplit: ClusterSplit = .none,
        now: Date = Date()
    ) -> [SidebarGroup] {
        // Pinned work leads the list under every grouping, above clusters too.
        //
        // A pin says "keep this where I can find it", which only holds if its position does not
        // depend on the sort in effect. So pinned rows are lifted into their own group and removed
        // from the groups below rather than sorted first within them — otherwise switching to
        // project grouping would scatter them back down the list.
        let pinned = rows.filter(\.pinned)
        if !pinned.isEmpty {
            let rest = rows.filter { !$0.pinned }
            return [SidebarGroup(key: "pinned", name: "Pinned", rows: pinned, children: [])]
                + group(rows: rest, by: mode, clusterFirst: clusterFirst, clusterSplit: clusterSplit, now: now)
        }

        // Clusters are a lens, not an arrangement: when it is on, a fleet is lifted out of the
        // list and everything else keeps whatever order the chosen mode gives it.
        if clusterFirst {
            let clustered = rows.filter { $0.membership?.cluster != nil }
            if !clustered.isEmpty {
                let rest = rows.filter { $0.membership?.cluster == nil }
                let byCluster = ordered(
                    clustered,
                    keyed: { $0.membership?.cluster ?? "Cluster" },
                    order: nil,
                    title: { $0 }
                ).map { cluster in
                    split(cluster, by: clusterSplit)
                }
                return byCluster + group(rows: rest, by: mode, clusterFirst: false, now: now)
            }
        }
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
            return rows.isEmpty ? [] : [SidebarGroup(key: "all", name: "All", rows: rows, children: [])]
        }
    }

    /// Break one cluster into nested parts, leaving whatever the axis cannot place directly under
    /// the cluster itself.
    ///
    /// Nested rather than flattened into "cluster · part" siblings: the fleet is one thing with
    /// parts, and collapsing the cluster should take its events with it.
    private static func split(_ cluster: SidebarGroup, by split: ClusterSplit) -> SidebarGroup {
        guard split != .none else { return cluster }
        var direct: [SidebarRow] = []
        var parts: [String: [SidebarRow]] = [:]
        var appearance: [String] = []
        for row in cluster.rows {
            guard let part = split.part(of: row) else {
                direct.append(row)
                continue
            }
            if parts[part] == nil { appearance.append(part) }
            parts[part, default: []].append(row)
        }
        guard !appearance.isEmpty else { return cluster }
        return SidebarGroup(
            key: cluster.key,
            name: cluster.name,
            rows: direct,
            children: appearance.map { part in
                SidebarGroup(key: "\(cluster.key)/\(part)", name: part, rows: parts[part] ?? [], children: [])
            }
        )
    }

    private static func ordered(
        _ rows: [SidebarRow],
        keyed key: (SidebarRow) -> String,
        order: [String]?,
        title: (String) -> String
    ) -> [SidebarGroup] {
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
            return SidebarGroup(key: key, name: title(key), rows: bucket, children: [])
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
