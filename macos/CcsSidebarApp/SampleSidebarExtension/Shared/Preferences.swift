import Foundation

/// Display choices that outlive a launch.
///
/// How the queue is arranged and how a row is drawn are standing decisions, not per-visit ones —
/// the web sidebar remembers them too, and a native surface that forgot would feel broken beside
/// it. The panel is torn down and rebuilt whenever cmux swaps providers, so anything held only in
/// view state is lost several times a day; a toggle you have to set again on every reopen is not
/// a toggle. Scope is deliberately not remembered: it is where you are looking right now.
public enum Preferences {
    private static let defaults = UserDefaults.standard

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
