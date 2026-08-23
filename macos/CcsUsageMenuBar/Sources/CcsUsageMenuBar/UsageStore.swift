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
    /// Account local-parts whose live Anthropic fetch failed — data shown is stale.
    @Published var staleAccounts: Set<String> = []
    /// Live plan tiers read from the keychain, keyed "provider|account".
    @Published var planOverrides: [String: PlanInfo] = [:]

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
                await self.refreshAnthropicLive(accounts: accounts)
            }
        }
    }

    /// Fetch live usage straight from Anthropic's OAuth endpoint per account,
    /// bypassing cswap's (often stale) usage cache. Falls back to the ccs data
    /// when a token is missing or revoked, marking the account stale.
    private func refreshAnthropicLive(accounts: [CswapAccount]) async {
        for account in accounts {
            let key = "anthropic|\(account.email.split(separator: "@").first.map(String.init) ?? account.email)"
            guard let creds = Keychain.claudeOauth(account: account) else {
                await MainActor.run { _ = self.staleAccounts.insert(key) }
                continue
            }
            do {
                let usage = try AnthropicDirect.fetchUsage(token: creds.token)
                let fresh = AnthropicDirect.observations(email: account.email, usage: usage)
                await MainActor.run {
                    self.staleAccounts.remove(key)
                    if let tierPlan = AnthropicDirect.plan(forTier: creds.tier) {
                        self.planOverrides[key] = tierPlan
                    }
                    // Replace this account's anthropic rows with live ones.
                    self.observations.removeAll {
                        $0.provider == "anthropic" && $0.entitlement.contains(account.email)
                    }
                    self.observations.append(contentsOf: fresh)
                    self.gauges = GaugeBuilder.sections(from: UsageSnapshot(generatedAt: nil, observations: self.observations)).flatMap(\.gauges)
                    self.updateHeight(from: UsageSnapshot(generatedAt: nil, observations: self.observations))
                    self.phase = .loaded(Date())
                }
            } catch {
                await MainActor.run { _ = self.staleAccounts.insert(key) }
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
        Task { [ccsPath] in
            do {
                let snapshot = try await UsageFetcher.fetch(ccsPath: ccsPath)
                let built = GaugeBuilder.sections(from: snapshot).flatMap(\.gauges)
                await MainActor.run {
                    self.gauges = built
                    self.observations = snapshot.observations
                    self.updateHeight(from: snapshot)
                    self.phase = .loaded(snapshot.generatedAt ?? Date())
                }
            } catch {
                await MainActor.run {
                    if self.gauges.isEmpty { self.phase = .failed(error.localizedDescription) }
                    else { self.phase = .failed(error.localizedDescription) }
                }
            }
        }
    }

    var sections: [UsageSection] {
        GaugeBuilder.sections(
            from: UsageSnapshot(generatedAt: nil, observations: observations),
            planOverrides: planOverrides
        )
    }

    var overallRemaining: Double? {
        GaugeBuilder.overallUsedFraction(sections).map { 1 - $0 }
    }
}
