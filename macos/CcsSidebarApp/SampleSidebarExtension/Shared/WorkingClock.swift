import Foundation
import Observation

/// How long each running session has been running, ticking once a second.
///
/// The snapshot says a session is Running but not since when, so the start is observed here: the
/// first tick that sees a row working is the start, and it survives until the row stops. That makes
/// the number honest about what it measures — how long this sidebar has watched it work — rather
/// than inventing a history it cannot know.
///
/// A single clock for the whole list, not one per row. Four hundred independent timers would wake
/// the process four hundred times a second to redraw a handful of visible labels.
@Observable
@MainActor
public final class WorkingClock {
    /// Bumped every second; views that read it re-evaluate, and nothing else does.
    public private(set) var tick = 0

    private var startedAt: [String: Date] = [:]
    private var timer: Task<Void, Never>?

    public init() {}

    public func start() {
        guard timer == nil else { return }
        timer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                self?.tick &+= 1
            }
        }
    }

    public func stop() {
        timer?.cancel()
        timer = nil
    }

    /// Records which sessions are working now, and forgets the ones that stopped.
    public func observe(rows: [SidebarRow]) {
        let working = Set(rows.filter(\.isWorking).map(\.id))
        for id in working where startedAt[id] == nil { startedAt[id] = Date() }
        startedAt = startedAt.filter { working.contains($0.key) }
    }

    /// A compact elapsed label, or nil until a full second has passed so it does not flash "0s".
    public func elapsed(for row: SidebarRow) -> String? {
        guard let start = startedAt[row.id] else { return nil }
        let seconds = Int(Date().timeIntervalSince(start))
        guard seconds >= 1 else { return nil }
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3_600 { return "\(seconds / 60)m \(seconds % 60)s" }
        return "\(seconds / 3_600)h \((seconds % 3_600) / 60)m"
    }
}

public extension SidebarRow {
    /// Working means cmux says the agent is producing, not merely that the session is alive.
    var isWorking: Bool {
        guard let label = status?.label.lowercased() else { return false }
        return label == "running" || label == "working"
    }
}
