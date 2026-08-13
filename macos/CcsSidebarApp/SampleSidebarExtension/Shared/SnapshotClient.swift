import Foundation
import Observation

/// Polls the sidebar server and publishes the rows it returns.
///
/// The extension is a client of the same endpoint the web sidebar uses. Everything hard — reading
/// the catalogue and index, projecting rows, enrichment, categories, talking to cmux — already
/// happens behind it, so this type deliberately knows nothing except how to ask.
///
/// One second matches the web client's cadence. Failures leave the last good rows in place rather
/// than blanking the list: a sidebar that empties itself because one request timed out is worse
/// than one showing figures a second old.
@Observable
@MainActor
public final class SnapshotClient {
    public private(set) var rows: [SidebarRow] = []
    public private(set) var lastError: String?
    public private(set) var livenessReadable = true

    public private(set) var counts: [String: Int] = [:]
    public private(set) var truncated = false
    public var scope: SidebarScope = .active {
        didSet { if scope != oldValue { Task { await refresh(freshLiveness: true) } } }
    }

    /// Settled once the host has said which workspaces it owns; until then the default is used.
    public private(set) var port: Int
    private let limit: Int
    private let interval: Duration
    private var pollTask: Task<Void, Never>?

    public init(port: Int = 8788, limit: Int = 2_000, interval: Duration = .seconds(1)) {
        self.port = port
        self.limit = limit
        self.interval = interval
    }

    /// Closed scopes need their rows requested explicitly; the server only projects a section it
    /// was asked for, which is what keeps the active view from carrying hundreds of finished rows.
    private var endpoint: URL {
        var url = "http://127.0.0.1:\(port)/api/snapshot?limit=\(limit)&scope=\(scope.rawValue)"
        if scope == .active { url += "&include=saved" }
        return URL(string: url)!
    }

    public func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: self?.interval ?? .seconds(1))
            }
        }
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Point at whichever server describes the cmux hosting this sidebar.
    ///
    /// Re-run whenever the host's workspaces change, which is the only signal available that the
    /// sidebar may have been moved to a different cmux.
    public func adopt(hostWorkspaceIds: Set<String>) async {
        guard let found = await ServerLocator.locate(hostWorkspaceIds: hostWorkspaceIds),
              found != port
        else { return }
        port = found
        await refresh(freshLiveness: true)
    }

    /// Fetch immediately, telling the server not to answer from its caches.
    ///
    /// Called after an action, because the state it changed lives behind two 2.5-second caches —
    /// the serialized snapshot and the cmux liveness read. Waiting them out is what made closing
    /// or switching a session take seconds to appear when the action itself was instant.
    public func refreshNow() async {
        await refresh(freshLiveness: true)
    }

    private func refresh(freshLiveness: Bool = false) async {
        do {
            var request = URLRequest(url: endpoint)
            // The server drops this query's cached representation and re-reads liveness rather
            // than serving the previous projection.
            if freshLiveness { request.setValue("1", forHTTPHeaderField: "x-ccs-refresh-liveness") }
            let (data, _) = try await URLSession.shared.data(for: request)
            let snapshot = try JSONDecoder().decode(SidebarSnapshot.self, from: data)
            rows = snapshot.rows
            counts = snapshot.lifecycleCounts ?? [:]
            truncated = snapshot.hasMoreRows ?? false
            livenessReadable = snapshot.livenessReadable
            lastError = nil
        } catch {
            // Retained on purpose: the rows already on screen stay true until contradicted.
            lastError = error.localizedDescription
        }
    }
}
