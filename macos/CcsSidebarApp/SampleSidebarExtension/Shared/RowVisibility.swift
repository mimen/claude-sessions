import Foundation

/// Which sessions the list carries at all.
///
/// A fleet keeps its finished workers for their transcripts, so event-watch arrives as thirty rows
/// of which a handful are running. Answering "what is my fleet doing" by reading past the other
/// twenty-odd is the problem this removes. Deliberately separate from whether a group is collapsed:
/// one says what the list is about, the other says how much of it you want on screen right now, and
/// tangling them made a single control that could not express "open sessions, all groups showing".
public enum RowVisibility: String, CaseIterable, Sendable {
    /// Everything the scope holds, running or finished.
    case all
    /// Only sessions that are still running.
    case openOnly

    public var title: String {
        switch self {
        case .all: return "All sessions"
        case .openOnly: return "Only open sessions"
        }
    }

    /// Applied before grouping, so a group with nothing running does not render an empty header —
    /// which is most of what makes the filtered sidebar short.
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
