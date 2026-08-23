import Foundation

/// Display choices that outlive a launch.
///
/// How the queue is arranged and how a row is drawn are standing decisions, not per-visit ones —
/// the web sidebar remembers them too, and a native surface that forgot would feel broken beside
/// it. The panel is torn down and rebuilt whenever cmux swaps providers, so anything held only in
/// view state is lost several times a day; a toggle you have to set again on every reopen is not
/// a toggle. The selected view is a standing choice too, including the dedicated T3 Code view.
public enum Preferences {
    private static let defaults = UserDefaults.standard

    public static var scope: SidebarScope {
        get { SidebarScope(rawValue: defaults.string(forKey: "ccs.scope") ?? "") ?? .active }
        set { defaults.set(newValue.rawValue, forKey: "ccs.scope") }
    }

    public static var grouping: GroupingMode {
        get { GroupingMode(rawValue: defaults.string(forKey: "ccs.grouping") ?? "") ?? .status }
        set { defaults.set(newValue.rawValue, forKey: "ccs.grouping") }
    }

    /// Whether fleets are lifted out of the list into their own groups.
    public static var clusterFirst: Bool {
        get { defaults.bool(forKey: "ccs.clusterFirst") }
        set { defaults.set(newValue, forKey: "ccs.clusterFirst") }
    }

    /// How a lifted cluster is broken up.
    public static var clusterSplit: ClusterSplit {
        get { ClusterSplit(rawValue: defaults.string(forKey: "ccs.clusterSplit") ?? "") ?? .none }
        set { defaults.set(newValue.rawValue, forKey: "ccs.clusterSplit") }
    }

    /// Which groups are shelved. Keyed by group key, so a section collapsed under one grouping
    /// stays collapsed when you come back to it and does not shelve an unrelated section that
    /// happens to sit in the same position.
    public static var collapsedGroups: Set<String> {
        get { Set(defaults.stringArray(forKey: "ccs.collapsedGroups") ?? []) }
        set { defaults.set(Array(newValue).sorted(), forKey: "ccs.collapsedGroups") }
    }

    /// Which groups are filtered to their open sessions. Keyed by group key like the collapse
    /// state, and stored separately from it because the two are independent choices about the same
    /// group: either can be set without disturbing the other.
    public static var groupVisibility: [String: RowVisibility] {
        get {
            let stored = defaults.dictionary(forKey: "ccs.groupVisibility") as? [String: String] ?? [:]
            return stored.compactMapValues(RowVisibility.init(rawValue:))
        }
        set { defaults.set(newValue.mapValues(\.rawValue), forKey: "ccs.groupVisibility") }
    }

    public static var layouts: RowLayouts {
        get {
            RowLayouts(
                open: RowLayout(rawValue: defaults.string(forKey: "ccs.layout.open") ?? "") ?? .wide,
                closed: RowLayout(rawValue: defaults.string(forKey: "ccs.layout.closed") ?? "") ?? .wide
            )
        }
        set {
            defaults.set(newValue.open.rawValue, forKey: "ccs.layout.open")
            defaults.set(newValue.closed.rawValue, forKey: "ccs.layout.closed")
        }
    }
}
