import AppKit
import Foundation
import SwiftUI

/// What the menu bar label shows: 5h only, 7d only, or both as "5h / 7d".
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
                let snapshot = try await UsageFetcher.fetch(ccsPath: ccsPath)
                let built = GaugeBuilder.sections(from: snapshot).flatMap(\.gauges)
                await MainActor.run {
                    self.gauges = built
                    self.snapshot = snapshot
                    self.adapterNotes = GaugeBuilder.healthNotes(snapshot.adapters)
                    self.updateHeight(from: snapshot)
                    self.phase = .loaded(snapshot.generatedAt ?? Date())
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
        GaugeBuilder.sections(from: snapshot)
    }

    var overallReading: OverallReading {
        GaugeBuilder.overallReading(sections)
    }
}
