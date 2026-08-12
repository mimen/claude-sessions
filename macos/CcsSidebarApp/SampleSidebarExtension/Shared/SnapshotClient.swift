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

    private let endpoint: URL
    private let interval: Duration
    private var pollTask: Task<Void, Never>?

    public init(port: Int = 8788, limit: Int = 2_000, interval: Duration = .seconds(1)) {
        endpoint = URL(string: "http://127.0.0.1:\(port)/api/snapshot?limit=\(limit)")!
        self.interval = interval
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

    private func refresh() async {
        do {
            let (data, _) = try await URLSession.shared.data(from: endpoint)
            let snapshot = try JSONDecoder().decode(SidebarSnapshot.self, from: data)
            rows = snapshot.rows
            livenessReadable = snapshot.livenessReadable
            lastError = nil
        } catch {
            // Retained on purpose: the rows already on screen stay true until contradicted.
            lastError = error.localizedDescription
        }
    }
}
