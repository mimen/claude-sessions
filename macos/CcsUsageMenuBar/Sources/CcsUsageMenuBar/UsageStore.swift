import AppKit
import Foundation
import SwiftUI

/// What the menu bar label shows: 5h only, 7d only, or both as "5h / 7d".
enum DragItem: Equatable {
    case section(String)
    case row(section: String, gauge: String)
}

enum OverallMode: String, CaseIterable, Identifiable {
    case fiveHour = "5h"
    case sevenDay = "7d"
    case both = "5h / 7d"
    var id: String { rawValue }
}

@MainActor
final class UsageStore: ObservableObject {
    enum Phase: Equatable {
        case idle
        case loading
        case loaded(Date)
        case failed(String)

        var failureMessage: String? {
            if case .failed(let message) = self { return message }
            return nil
        }
    }

    @Published var phase: Phase = .idle
    @Published var gauges: [UsageGauge] = []
    @Published var snapshot = UsageSnapshot(generatedAt: nil, observations: [])
    @Published var panelHeight: CGFloat = 420
    @Published var cswapAccounts: [CswapAccount] = []
    @Published var switchingTo: CswapAccount?
    @Published var switchError: String?
    @Published var adapterNotes: [String] = []
    @Published var overallMode: OverallMode =
        UserDefaults.standard.string(forKey: "overallMode").flatMap(OverallMode.init) ?? .both {
        didSet { UserDefaults.standard.set(overallMode.rawValue, forKey: "overallMode") }
    }

    /// Section ids ("provider|account") in the order the user dragged them into.
    @Published var sectionOrder: [String] = UserDefaults.standard.stringArray(forKey: "sectionOrder") ?? [] {
        didSet { UserDefaults.standard.set(sectionOrder, forKey: "sectionOrder") }
    }
    /// Gauge ids in the order the user dragged them into, keyed by section id.
    @Published var rowOrder: [String: [String]] =
        UserDefaults.standard.dictionary(forKey: "rowOrder") as? [String: [String]] ?? [:] {
        didSet { UserDefaults.standard.set(rowOrder, forKey: "rowOrder") }
    }
    /// The section header or gauge row being dragged. Rows only reorder within their section.
    @Published var dragging: DragItem?
    /// When ccs last answered. Kept across failures so the footer can age what is on screen.
    @Published var lastSuccess: Date?

    private var hasLoadedCswap = false
    private var basePanelHeight: CGFloat = 420

    func updateHeight(from snapshot: UsageSnapshot) {
        basePanelHeight = GaugeBuilder.panelHeight(
            for: GaugeBuilder.sections(from: snapshot),
            noteCount: GaugeBuilder.healthNotes(snapshot.adapters).count
        )
        syncPanelHeight()
    }

    func syncPanelHeight() {
        let switcher = cswapAccounts.isEmpty ? 0 : CGFloat(cswapAccounts.count) * 26 + 30
        panelHeight = min(basePanelHeight + switcher, 680)
    }

    func loadCswapAccountsIfNeeded() {
        guard !hasLoadedCswap, Cswap.isAvailable() else { return }
        hasLoadedCswap = true
        Task {
            if let accounts = try? Cswap.accounts() {
                await MainActor.run {
                    self.cswapAccounts = accounts
                    self.syncPanelHeight()
                }
            }
        }
    }

    func switchClaudeAccount(_ account: CswapAccount) {
        guard switchingTo == nil else { return }
        switchingTo = account
        switchError = nil
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                try Cswap.switchTo(account)
                let accounts = try? Cswap.accounts()
                await MainActor.run {
                    self?.switchingTo = nil
                    if let accounts { self?.cswapAccounts = accounts }
                }
            } catch {
                await MainActor.run {
                    self?.switchingTo = nil
                    self?.switchError = error.localizedDescription
                }
            }
        }
    }

    private let ccsPath: String
    private let pollInterval: TimeInterval
    private var timer: Timer?

    nonisolated init(ccsPath: String = CcsLocator.resolve(), pollInterval: TimeInterval = 5 * 60) {
        self.ccsPath = ccsPath
        self.pollInterval = pollInterval
    }

    private var wakeObserver: NSObjectProtocol?

    func startPolling() {
        refresh()
        timer?.invalidate()
        let timer = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refresh() }
        }
        timer.tolerance = pollInterval / 10
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        // Sleep suspends the timer; the numbers on screen are as old as the nap.
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                Self.log("wake")
                self?.refresh()
            }
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
        }
        wakeObserver = nil
    }

    func refresh() {
        guard phase != .loading else { return }
        phase = .loading
        Self.log("refresh start")
        Task { [ccsPath] in
            do {
                let t0 = Date()
                let fetched = try await UsageFetcher.fetch(ccsPath: ccsPath)
                let snapshot = await MainActor.run { fetched.carryingForward(self.snapshot) }
                let built = GaugeBuilder.sections(from: snapshot).flatMap(\.gauges)
                await MainActor.run {
                    self.gauges = built
                    self.snapshot = snapshot
                    self.adapterNotes = GaugeBuilder.healthNotes(snapshot.adapters)
                    self.updateHeight(from: snapshot)
                    self.phase = .loaded(snapshot.generatedAt ?? Date())
                    self.lastSuccess = snapshot.generatedAt ?? Date()
                }
                Self.log("refresh ok in \(Int(-t0.timeIntervalSinceNow))s, \(snapshot.observations.count) obs")
            } catch {
                Self.log("refresh FAILED: \(error)")
                await MainActor.run {
                    self.phase = .failed(error.localizedDescription)
                }
            }
        }
    }

    /// Local time, so the log lines up with crash reports and pmset without conversion.
    private static let logClock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss ZZZZZ"
        return f
    }()
    private static let logCap: UInt64 = 2 * 1024 * 1024

    static func log(_ message: String) {
        let path = NSHomeDirectory() + "/.ccs-usage-menubar.log"
        let line = Data("\(Self.logClock.string(from: Date())) \(message)\n".utf8)
        if let handle = FileHandle(forWritingAtPath: path) {
            defer { handle.closeFile() }
            if (try? handle.seekToEnd()) ?? 0 > logCap {
                try? handle.truncate(atOffset: 0)
            }
            handle.write(line)
        } else {
            try? line.write(to: URL(fileURLWithPath: path))
        }
    }

    var sections: [UsageSection] {
        GaugeBuilder.ordered(GaugeBuilder.sections(from: snapshot), by: sectionOrder).map { s in
            s.withGauges(GaugeBuilder.ordered(s.gauges, by: rowOrder[s.id] ?? [], id: \.id))
        }
    }

    func move(_ item: DragItem, onto target: DragItem) {
        switch (item, target) {
        case (.section(let moving), .section(let onto)):
            let ids = sections.map(\.id)
            let next = GaugeBuilder.reordered(ids, moving: moving, onto: onto)
            if next != ids { sectionOrder = next }
        case (.row(let section, let moving), .row(let targetSection, let onto)) where section == targetSection:
            guard let ids = sections.first(where: { $0.id == section })?.gauges.map(\.id) else { return }
            let next = GaugeBuilder.reordered(ids, moving: moving, onto: onto)
            if next != ids { rowOrder[section] = next }
        default:
            break
        }
    }

    /// Two missed polls: the numbers on screen may no longer match the provider.
    func isOutdated(now: Date) -> Bool {
        lastSuccess.map { now.timeIntervalSince($0) > 2 * pollInterval + 60 } ?? false
    }

    var overallReading: OverallReading {
        GaugeBuilder.overallReading(sections)
    }
}
