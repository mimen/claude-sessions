import Foundation
import Observation

/// Polls the sidebar server and publishes the rows it returns.
///
/// The extension is a client of the same endpoint the web sidebar uses. Everything hard — reading
/// the catalogue and index, projecting rows, enrichment, categories, talking to cmux — already
/// happens behind it, so this type deliberately knows nothing except how to ask.
///
/// Polling is the fallback, not the mechanism. The server follows cmux's own event stream and
/// publishes a revision whenever anything the sidebar draws from changed, so the ordinary case is
/// that a change arrives as soon as it happens and the timer is only there for whatever the stream
/// never hears about. That is why the interval stretches once the stream is connected: a one-second
/// poll behind a working change channel is repeated work that answers a question already answered.
///
/// Failures leave the last good rows in place rather than blanking the list: a sidebar that empties
/// itself because one request timed out is worse than one showing figures a second old.
@Observable
@MainActor
public final class SnapshotClient {
    typealias SnapshotDataLoader = @Sendable (URLRequest) async throws -> Data

    public private(set) var rows: [SidebarRow] = []
    public private(set) var lastError: String?
    public private(set) var livenessReadable = true
    /// The version the server last ANSWERED with — not fetched separately, so a footer that stops
    /// tracking a redeploy is also evidence that snapshots have stopped arriving.
    public private(set) var serverVersion: String?

    public private(set) var counts: [String: Int] = [:]
    public private(set) var truncated = false
    public var scope: SidebarScope = .active {
        didSet {
            guard scope != oldValue else { return }
            // Retire in-flight requests for the old scope now, not when the new refresh happens to
            // start — otherwise an old-scope response landing in that window paints the previous
            // scope's rows under the new header.
            refreshGeneration += 1
            Task { await refreshPending(freshLiveness: true) }
        }
    }

    /// While a search is typed, the active view also asks for the finished lifecycles so the
    /// query can find completed and saved sessions; cleared with the query so the everyday
    /// snapshot stays small.
    public var searchIncludesFinished = false {
        didSet {
            guard searchIncludesFinished != oldValue else { return }
            refreshGeneration += 1
            Task { await refreshPending() }
        }
    }

    /// Whether the server's change channel is currently carrying us. Drives the poll interval.
    public private(set) var changeStreamConnected = false

    public let port: Int
    private let limit: Int
    private let interval: Duration
    private let backstopInterval: Duration
    private let snapshotData: SnapshotDataLoader
    private var pollTask: Task<Void, Never>?
    private var changeTask: Task<Void, Never>?
    /// The newest revision whose snapshot was successfully applied.
    private var lastRevision: Int?
    /// A reported revision still waiting for bytes built from at least that revision.
    private var pendingRevision: Int?
    /// Issue number of the newest refresh. URLSession answers in whatever order the network allows,
    /// so without this a slow older response can land after a faster newer one and put rows that
    /// were already replaced back on screen — stale highlights that stay until the next poll.
    private var refreshGeneration = 0

    public convenience init(
        port: Int = SidebarServer.defaultPort,
        limit: Int = 2_000,
        interval: Duration = .seconds(1),
        backstopInterval: Duration = .seconds(5)
    ) {
        self.init(
            port: port,
            limit: limit,
            interval: interval,
            backstopInterval: backstopInterval,
            snapshotData: { request in
                let (data, _) = try await URLSession.shared.data(for: request)
                return data
            }
        )
    }

    init(
        port: Int,
        limit: Int = 2_000,
        interval: Duration = .seconds(1),
        backstopInterval: Duration = .seconds(5),
        snapshotData: @escaping SnapshotDataLoader
    ) {
        self.port = port
        self.limit = limit
        self.interval = interval
        self.backstopInterval = backstopInterval
        self.snapshotData = snapshotData
    }

    /// Closed scopes need their rows requested explicitly; the server only projects a section it
    /// was asked for, which is what keeps the active view from carrying hundreds of finished rows.
    private var endpoint: URL {
        var url = "http://127.0.0.1:\(port)/api/snapshot?limit=\(limit)&scope=\(scope.rawValue)"
        if scope == .active {
            url += searchIncludesFinished ? "&include=saved,completed" : "&include=saved"
        }
        return URL(string: url)!
    }

    public func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshPending()
                let wait = self?.pollWait ?? .seconds(1)
                try? await Task.sleep(for: wait)
            }
        }
        changeTask = Task { [weak self] in
            await self?.followChanges()
        }
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
        changeTask?.cancel()
        changeTask = nil
        changeStreamConnected = false
    }

    private var pollWait: Duration {
        changeStreamConnected ? backstopInterval : interval
    }

    private var changeEndpoint: URL {
        URL(string: "http://127.0.0.1:\(port)/api/events")!
    }

    /// Follow the server's change channel, reconnecting for as long as anyone is watching.
    ///
    /// Reconnection is unconditional and backed off rather than given up on: the stream going away
    /// means the server restarted or is being deployed, which is exactly when a sidebar left
    /// polling every five seconds would feel broken. The poll interval tightens on its own while
    /// disconnected, so a permanent outage degrades to the behaviour that existed before this.
    private func followChanges() async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                var request = URLRequest(url: changeEndpoint)
                // Long-lived by construction. The server heartbeats well inside this, so a silent
                // connection is still proven alive rather than being torn down as idle.
                request.timeoutInterval = 3_600
                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                    throw URLError(.badServerResponse)
                }
                changeStreamConnected = true
                attempt = 0
                // Whether the stream is up decides whether the sidebar is live or on a five-second
                // timer, and from inside an appex there is no other way to find out.
                Diagnostics.note("change stream: connected to port \(port)")
                for try await line in bytes.lines {
                    if Task.isCancelled { break }
                    guard let revision = Self.revision(inFrame: line) else { continue }
                    await receiveRevision(revision)
                }
            } catch {
                // Not shown to the reader: losing the stream costs responsiveness, not
                // correctness, and a banner for it would cry wolf during every deploy.
                Diagnostics.note("change stream: \(error.localizedDescription)")
            }
            if changeStreamConnected { Diagnostics.note("change stream: disconnected") }
            changeStreamConnected = false
            if Task.isCancelled { return }
            let backoff = Self.reconnectDelays[min(attempt, Self.reconnectDelays.count - 1)]
            attempt += 1
            try? await Task.sleep(for: backoff)
        }
    }

    private static let reconnectDelays: [Duration] = [
        .milliseconds(250), .seconds(1), .seconds(2), .seconds(5),
    ]
    private static let snapshotTimeout: TimeInterval = 5

    /// Pull the revision out of one SSE frame, ignoring heartbeats and anything unrecognised.
    ///
    /// Pure text handling touching no state, so it is deliberately outside the actor: keeping it in
    /// would make parsing a line an await from anywhere else, tests included.
    nonisolated static func revision(inFrame line: String) -> Int? {
        guard line.hasPrefix("data:") else { return nil }
        let payload = line.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
        guard let data = payload.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let revision = object["revision"] as? Int
        else { return nil }
        return revision
    }

    func receiveRevision(_ revision: Int) async {
        guard revision != lastRevision, revision != pendingRevision else { return }
        // The frame names the minimum revision the next accepted snapshot must contain. Even the
        // opening frame is fetched: it may race start()'s poll, and only the stamped response proves
        // which answer describes the current world.
        pendingRevision = revision
        await refreshPending()
    }

    /// Fetch immediately, telling the server not to answer from its caches.
    ///
    /// Called after an action, because the state it changed lives behind two 2.5-second caches —
    /// the serialized snapshot and the cmux liveness read. Waiting them out is what made closing
    /// or switching a session take seconds to appear when the action itself was instant.
    public func refreshNow() async {
        await refreshPending(freshLiveness: true)
    }

    @discardableResult
    func refreshPending(freshLiveness: Bool = false) async -> Bool {
        let targetRevision = pendingRevision
        let applied = await refresh(
            freshLiveness: freshLiveness,
            minimumRevision: targetRevision
        )
        if applied, pendingRevision == targetRevision {
            lastRevision = targetRevision ?? lastRevision
            pendingRevision = nil
        }
        return applied
    }

    private func refresh(
        freshLiveness: Bool = false,
        minimumRevision: Int? = nil
    ) async -> Bool {
        for attempt in 0..<2 {
            refreshGeneration += 1
            let generation = refreshGeneration
            do {
                var request = URLRequest(url: endpoint)
                // A wedged request must release the poll loop on its own; reopening the extension is
                // not a recovery mechanism. The event stream remains independent and long-lived.
                request.timeoutInterval = Self.snapshotTimeout
                // The server drops this query's cached representation and re-reads liveness rather
                // than serving the previous projection.
                if freshLiveness {
                    request.setValue("1", forHTTPHeaderField: "x-ccs-refresh-liveness")
                }
                let data = try await snapshotData(request)
                // A newer refresh was issued while this one was on the wire; its answer is the past.
                guard generation == refreshGeneration else { return false }
                let snapshot = try JSONDecoder().decode(SidebarSnapshot.self, from: data)
                if let minimumRevision,
                   let snapshotRevision = snapshot.snapshotRevision,
                   snapshotRevision < minimumRevision {
                    if attempt == 0 { continue }
                    return false
                }
                rows = snapshot.rows
                counts = snapshot.lifecycleCounts ?? [:]
                truncated = snapshot.hasMoreRows ?? false
                livenessReadable = snapshot.livenessReadable
                serverVersion = snapshot.serverVersion
                lastError = nil
                return true
            } catch {
                guard generation == refreshGeneration else { return false }
                // Retained on purpose: the rows already on screen stay true until contradicted.
                lastError = error.localizedDescription
                return false
            }
        }
        return false
    }
}
