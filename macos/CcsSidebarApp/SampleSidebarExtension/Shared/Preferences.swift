import Foundation

/// Display choices that outlive a launch.
///
/// How the queue is arranged and how a row is drawn are standing decisions, not per-visit ones —
/// the web sidebar remembers them too, and a native surface that forgot would feel broken beside
/// it. Scope is deliberately not remembered: it is where you are looking right now.
public enum Preferences {
    private static let defaults = UserDefaults.standard

    public static var grouping: GroupingMode {
        get { GroupingMode(rawValue: defaults.string(forKey: "ccs.grouping") ?? "") ?? .status }
        set { defaults.set(newValue.rawValue, forKey: "ccs.grouping") }
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
