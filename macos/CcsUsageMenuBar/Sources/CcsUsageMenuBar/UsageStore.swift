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
                let built = GaugeBuilder.build(from: snapshot)
                await MainActor.run {
                    self.gauges = built
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

    var tightest: UsageGauge? { GaugeBuilder.tightest(gauges) }
}
