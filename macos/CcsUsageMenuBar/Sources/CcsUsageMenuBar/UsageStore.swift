import Foundation
import SwiftUI

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
    @Published var observations: [UsageObservation] = []
    @Published var panelHeight: CGFloat = 420
    @Published var cswapAccounts: [CswapAccount] = []
    @Published var switchingTo: CswapAccount?
    @Published var switchError: String?

    private var hasLoadedCswap = false
    private var basePanelHeight: CGFloat = 420

    func updateHeight(from snapshot: UsageSnapshot) {
        basePanelHeight = GaugeBuilder.panelHeight(for: GaugeBuilder.sections(from: snapshot))
        syncPanelHeight()
    }

    /// One number for how tall the panel is — usage gauges plus the account
    /// switcher — so the popover window always matches its content.
    func syncPanelHeight() {
        let switcher = cswapAccounts.isEmpty ? 0 : CGFloat(cswapAccounts.count) * 26 + 30
        panelHeight = min(basePanelHeight + switcher, 620)
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

    func startPolling() {
        refresh()
        timer?.invalidate()
        let timer = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
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
                    self.observations = snapshot.observations
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

    static func log(_ message: String) {
        let path = NSHomeDirectory() + "/.ccs-usage-menubar.log"
        let line = "\(Date()) \(message)\n"
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(line.data(using: .utf8)!)
            handle.closeFile()
        } else {
            try? line.write(toFile: path, atomically: true, encoding: .utf8)
        }
    }

    var sections: [UsageSection] {
        GaugeBuilder.sections(from: UsageSnapshot(generatedAt: nil, observations: observations))
    }

    var overallRemaining: Double? {
        GaugeBuilder.overallUsedFraction(sections).map { 1 - $0 }
    }
}
