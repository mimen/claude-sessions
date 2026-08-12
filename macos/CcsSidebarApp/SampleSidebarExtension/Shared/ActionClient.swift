import Foundation

/// Every mutation the sidebar can perform, as calls to the server that already performs them.
///
/// The web sidebar drives the same twelve endpoints, so the two surfaces cannot diverge on what an
/// action means: closing a workspace, refusing a verdict, or destroying a session is decided in one
/// place, with the catalogue writes and cmux calls that go with it.
public enum SidebarAction: Sendable {
    case open(sessionId: String)
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
        case let .open(sessionId): return ["sessionId": sessionId]
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

public struct ActionFailure: Error, Sendable {
    public let message: String
}

public struct ActionClient: Sendable {
    private let base: URL

    public init(port: Int = 8788) {
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
        request.httpBody = try JSONSerialization.data(withJSONObject: action.body)

        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let reason = json["message"] as? String ?? json["error"] as? String ?? "HTTP \(code)"
            throw ActionFailure(message: reason)
        }
        if let failure = json["closeFailed"] as? String { throw ActionFailure(message: failure) }
        return json
    }

    /// What destroying this session would take with it, so the confirmation can say so.
    public func destroyPreflight(sessionId: String) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent("/api/session/destroy/preflight"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["sessionId": sessionId])
        let (data, _) = try await URLSession.shared.data(for: request)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}
