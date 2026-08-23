import Foundation

/// Every mutation the sidebar can perform, as calls to the server that already performs them.
///
/// The web sidebar drives the same twelve endpoints, so the two surfaces cannot diverge on what an
/// action means: closing a workspace, refusing a verdict, or destroying a session is decided in one
/// place, with the catalogue writes and cmux calls that go with it.
public enum SidebarAction: Sendable {
    case open(sessionId: String, reopenCompleted: Bool = false, resumeT3Anyway: Bool = false)
    case lifecycle(sessionId: String, action: String)
    case declineSuggestion(sessionId: String, verb: String)
    case incognito(sessionId: String, incognito: Bool)
    case destroy(sessionId: String)
    case closeSession(sessionId: String)
    case focusWorkspace(workspaceId: String)
    case pinWorkspace(workspaceId: String, pinned: Bool)
    case closeWorkspace(workspaceId: String)

    var path: String {
        switch self {
        case .open: return "/api/open"
        case .lifecycle: return "/api/session/lifecycle"
        case .declineSuggestion: return "/api/session/decline"
        case .incognito: return "/api/session/incognito"
        case .destroy: return "/api/session/destroy"
        case .closeSession: return "/api/session/close"
        case .focusWorkspace: return "/api/workspace/focus"
        case .pinWorkspace: return "/api/workspace/pin"
        case .closeWorkspace: return "/api/workspace/close"
        }
    }

    var body: [String: Any] {
        switch self {
        case let .open(sessionId, reopenCompleted, resumeT3Anyway):
            var body: [String: Any] = ["sessionId": sessionId]
            if reopenCompleted { body["reopenCompleted"] = true }
            if resumeT3Anyway { body["resumeT3Anyway"] = true }
            return body
        case let .lifecycle(sessionId, action): return ["sessionId": sessionId, "action": action]
        case let .declineSuggestion(sessionId, verb): return ["sessionId": sessionId, "verb": verb]
        case let .incognito(sessionId, incognito): return ["sessionId": sessionId, "incognito": incognito]
        case let .destroy(sessionId): return ["sessionId": sessionId]
        case let .closeSession(sessionId): return ["sessionId": sessionId]
        case let .focusWorkspace(workspaceId): return ["workspaceId": workspaceId]
        case let .pinWorkspace(workspaceId, pinned): return ["workspaceId": workspaceId, "pinned": pinned]
        case let .closeWorkspace(workspaceId): return ["workspaceId": workspaceId]
        }
    }

    /// Destroy erases a session and its descendants from disk; nothing undoes it.
    public var isIrreversible: Bool {
        if case .destroy = self { return true }
        return false
    }
}

public enum SidebarServer {
    /// Production server for the ordinary cmux socket. Port 8788 is the isolated staging instance.
    public static let defaultPort = 8787
}

public struct ActionFailure: Error, Sendable {
    public let message: String
    public let refusal: String?
}

public struct ActionClient: Sendable {
    private let base: URL

    public init(port: Int = SidebarServer.defaultPort) {
        base = URL(string: "http://127.0.0.1:\(port)")!
    }

    /// Runs an action and surfaces the server's own refusal text.
    ///
    /// The server answers a refusal with a reason a person can act on — "ccs refused to close the
    /// workspace (shared-workspace)" rather than a status code — so the message is carried through
    /// unchanged instead of being replaced with something generic.
    @discardableResult
    public func perform(_ action: SidebarAction) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent(action.path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Every mutating endpoint requires the origin of the address the server bound. A browser
        // attaches it; URLSession does not, so without this the server refuses every action with
        // "the sidebar rejected this request". The guard exists to stop a page on another origin
        // POSTing here, which a native client cannot be tricked into doing.
        request.setValue(base.absoluteString, forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: action.body)

        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            // A named refusal says what to do instead; the envelope's message names only a class.
            let reason = Self.refusalMessage(json["refusal"] as? String)
                ?? json["message"] as? String
                ?? json["error"] as? String
                ?? "HTTP \(code)"
            throw ActionFailure(message: reason, refusal: json["refusal"] as? String)
        }
        if let failure = json["closeFailed"] as? String {
            throw ActionFailure(message: failure, refusal: nil)
        }
        return json
    }

    /// A sentence for each refusal a person can do something about. Mirrors the server's own list,
    /// which is the authority; an unknown code falls back to the envelope's class message.
    static func refusalMessage(_ refusal: String?) -> String? {
        switch refusal {
        case "shared-workspace":
            return "Another session shares this workspace, so CCS will not close it."
        case "not-primary-surface":
            return "This session is not the workspace's primary surface, so closing it would take the others with it."
        case "session-not-live":
            return "That session is no longer running."
        case "ambiguous-session-target":
            return "CCS could not tell which workspace this session means."
        case "session-workspace-mismatch", "session-surface-mismatch", "hook-workspace-mismatch":
            return "The session and its workspace disagree about where it lives. Refresh the list."
        // Resume refusals. Each names something retrying cannot fix, which is why they are worth
        // saying: the generic envelope told you to refresh the list and try again, forever.
        case "route-ineligible":
            return "No configured launcher can replay this session's model, so it cannot be resumed."
        case "unknown-launcher":
            return "This session names a launcher that is not in your CCS config."
        case "launcher-env-unresolvable":
            return "This session's launcher has an environment CCS could not resolve — check its secrets."
        case "spawn-failed":
            return "cmux would not create a workspace for this session."
        case "cwd-unreadable":
            return "This session's working directory could not be read, so CCS refused to spawn it."
        case "reactivation-failed":
            return "The session reopened but its lifecycle could not be moved back to Active."
        case "t3-confirmation-required":
            return "This session is associated with T3 Code. Resume it directly only if you intend to open another Claude Code runtime."
        default:
            return nil
        }
    }

    /// What destroying this session would take with it, so the confirmation can say so.
    public func destroyPreflight(sessionId: String) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent("/api/session/destroy/preflight"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(base.absoluteString, forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["sessionId": sessionId])
        let (data, _) = try await URLSession.shared.data(for: request)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}
