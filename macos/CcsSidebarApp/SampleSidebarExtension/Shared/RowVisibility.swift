import Foundation

/// Which of a group's sessions it shows.
///
/// A fleet keeps its finished workers for their transcripts, so event-watch arrives as thirty rows
/// of which a handful are running. Answering "what is my fleet doing" by reading past the other
/// twenty-odd is the problem this removes — and it is a question you ask of one group at a time,
/// which is why this is set per group rather than for the whole list.
///
/// Deliberately separate from whether a group is collapsed: one says what the group is about, the
/// other says how much of it you want on screen right now, and tangling them made a single control
/// that could not express "open sessions, all groups showing".
public enum RowVisibility: String, CaseIterable, Sendable {
    /// Everything the scope holds, running or finished.
    case all
    /// Only sessions that are still running.
    case openOnly

    public var title: String {
        switch self {
        case .all: return "Showing all sessions"
        case .openOnly: return "Showing only open sessions"
        }
    }

    var toggled: RowVisibility { self == .all ? .openOnly : .all }

    /// The header's filter mark. Filled while the group is filtered, so a glance down the sidebar
    /// says which groups are hiding something without reading any counts.
    var symbol: String {
        self == .openOnly ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle"
    }

    func filter(_ rows: [SidebarRow]) -> [SidebarRow] {
        switch self {
        case .all: return rows
        case .openOnly: return rows.filter(\.isOpen)
        }
    }
}

public extension SidebarRow {
    /// A session still running, or a workspace tab that is by definition on screen.
    ///
    /// The inverse of the ghost test the row already draws itself by, so "open" here means exactly
    /// what a full-density row means everywhere else in the sidebar.
    var isOpen: Bool { !isGhost }
}
