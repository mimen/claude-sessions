import Foundation

/// The sidebar's view of one session, decoded from `/api/snapshot`.
///
/// Deliberately a subset. The server already projects, sorts and enriches every row; this type
/// exists to read that projection, not to re-derive it, so a field belongs here only when a view
/// draws it. Everything is optional that the server can legitimately omit — a row with no model
/// is a closed session, not a decoding failure.
public struct SidebarRow: Decodable, Identifiable, Sendable, Equatable {
    public struct Status: Decodable, Sendable, Equatable {
        public let label: String
        public let icon: String?
        public let color: String?
    }

    public struct Model: Decodable, Sendable, Equatable {
        public let label: String
        public let color: String?
    }

    /// Which cluster and role a delegated session belongs to, when it belongs to one.
    public struct Membership: Decodable, Sendable, Equatable {
        public let cluster: String?
        public let role: String?
        /// The work item a fleet member is on — the event for an event-watch worker. Null for a
        /// core identity, which is its role rather than one unit of work.
        public let workRef: String?
        public let workLabel: String?
        /// When the work happens, epoch milliseconds, when the cluster recorded a date.
        public let workStartsAt: Double?
    }

    public struct Category: Decodable, Sendable, Equatable {
        public let compactLabel: String?
        public let hex: String?
    }

    /// True when CCS has marked this session as attached to a T3 thread.
    public let t3Associated: Bool?

    public struct Suggestion: Decodable, Sendable, Equatable {
        public let verb: String
        public let actionable: Bool
        public let reason: String?
        public let junk: Bool?
    }

    /// The enrichment's account of the session, and how far it has aged.
    public struct Summary: Decodable, Sendable, Equatable {
        public let state: String?
        public let history: String?
        public let next: String?
        public let remaining: String?
        public let recommendation: String?
        public let reason: String?
        public let junk: Bool
        public let messagesSince: Int?
        public let driftLabel: String?
    }

    public let id: String
    public let kind: String
    public let name: String
    public let directory: String?
    public let density: String
    public let section: String?
    public let lifecycle: String?
    public let t3Associated: Bool?
    public let status: Status?
    public let model: Model?
    public let category: Category?
    public let suggestion: Suggestion?
    public let lastActivityAt: Double?
    public let unread: Int
    public let workspaceRef: String?
    public let workspaceId: String?
    public let sessionId: String?
    public let summary: Summary?
    public let pinned: Bool
    public let focused: Bool
    public let shortcut: Int?
    public let worktree: String?
    public let faviconUrl: String?
    public let membership: Membership?

    /// A session that is no longer running: it keeps the grid but drops the facts that stopped
    /// being true. Mirrors the web sidebar's rule so the two cannot describe a row differently.
    public var isGhost: Bool { kind == "session" && density != "full" }
}

public struct SidebarSnapshot: Decodable, Sendable {
    public let rows: [SidebarRow]
    public let livenessReadable: Bool
    public let hasMoreRows: Bool?
    public let lifecycleCounts: [String: Int]?
    public let t3Count: Int?
    /// Release SHA of the server that answered; absent from servers predating the stamp.
    public let serverVersion: String?
}

/// The scopes the server will project, matching the web sidebar's own picker.
/// Mirrors the server's own `SIDEBAR_VIEWS`. A case the server does not serve is not a view the
/// picker may offer: it answers `bad_request`, the refresh throws, and the list silently keeps the
/// previous scope's rows under the new scope's name.
public enum SidebarScope: String, CaseIterable, Sendable {
    case active, saved, t3, completed, triage

    public var title: String {
        switch self {
        case .active: return "Active"
        case .saved: return "Saved"
        case .t3: return "T3 Code"
        case .completed: return "Done"
        case .triage: return "Triage"
        }
    }
}
