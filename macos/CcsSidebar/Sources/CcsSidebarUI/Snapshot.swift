import Foundation

/// The sidebar's view of one session, decoded from `/api/snapshot`.
///
/// Deliberately a subset. The server already projects, sorts and enriches every row; this type
/// exists to read that projection, not to re-derive it, so a field belongs here only when a view
/// draws it. Everything is optional that the server can legitimately omit — a row with no model
/// is a closed session, not a decoding failure.
public struct SidebarRow: Decodable, Identifiable, Sendable {
    public struct Status: Decodable, Sendable {
        public let label: String
        public let icon: String?
        public let color: String?
    }

    public struct Model: Decodable, Sendable {
        public let label: String
        public let color: String?
    }

    public struct Category: Decodable, Sendable {
        public let compactLabel: String?
        public let hex: String?
    }

    public struct Suggestion: Decodable, Sendable {
        public let verb: String
        public let actionable: Bool
        public let reason: String?
    }

    public let id: String
    public let kind: String
    public let name: String
    public let directory: String?
    public let density: String
    public let section: String?
    public let lifecycle: String?
    public let status: Status?
    public let model: Model?
    public let category: Category?
    public let suggestion: Suggestion?
    public let lastActivityAt: Double?
    public let unread: Int
    public let workspaceRef: String?

    /// A session that is no longer running: it keeps the grid but drops the facts that stopped
    /// being true. Mirrors the web sidebar's rule so the two cannot describe a row differently.
    public var isGhost: Bool { kind == "session" && density != "full" }
}

public struct SidebarSnapshot: Decodable, Sendable {
    public let rows: [SidebarRow]
    public let livenessReadable: Bool
}
