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

    func updateHeight(from snapshot: UsageSnapshot) {
        panelHeight = GaugeBuilder.panelHeight(for: GaugeBuilder.sections(from: snapshot))
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

    var overallRemaining: Double? {
        GaugeBuilder.overallUsedFraction(gauges).map { 1 - $0 }
    }
}
