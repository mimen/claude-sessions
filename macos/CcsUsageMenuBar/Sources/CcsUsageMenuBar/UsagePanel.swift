import SwiftUI

struct UsagePanel: View {
    @ObservedObject var store: UsageStore
    @State private var now = Date()
    private let ticker = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    content
                }
                .padding(.horizontal, 14)
                .padding(.top, 4)
            }
            footer
        }
        .frame(width: 320, height: panelHeight)
        .onReceive(ticker) { now = $0 }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .idle:
            spinner
        case .loading:
            if store.gauges.isEmpty {
                spinner
            } else {
                gaugeList
            }
        case .failed(let message):
            if store.gauges.isEmpty {
                errorView(message)
            } else {
                gaugeList
            }
        default:
            gaugeList
        }
    }

    private var spinner: some View {
        HStack {
            Spacer()
            ProgressView().controlSize(.small)
            Spacer()
        }
        .padding(.vertical, 30)
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.secondary)
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }

    @ViewBuilder
    private var gaugeList: some View {
        ForEach(groupedByProvider.sorted(by: { $0.key < $1.key }), id: \.key) { provider, gauges in
            ProviderSectionHeader(provider: provider)
            ForEach(gauges) { gauge in
                GaugeRow(gauge: gauge, now: now)
            }
        }
    }

    private var groupedByProvider: [String: [UsageGauge]] {
        Dictionary(grouping: store.gauges, by: \.provider)
    }

    private var panelHeight: CGFloat {
        let rows = CGFloat(store.gauges.count)
        let providers = CGFloat(groupedByProvider.count)
        return min(520, 56 + rows * 46 + providers * 28 + 20)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            switch store.phase {
            case .loaded:
                Text("updated \(now.formatted(.relative(presentation: .named)))")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
            case .loading:
                Text("refreshing…")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
            case .failed:
                Text(store.phase == .failed("") ? "" : "last refresh failed")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.orange)
            default:
                EmptyView()
            }
            Spacer()
            Button {
                store.refresh()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .rotationEffect(.degrees(store.phase == .loading ? 360 : 0))
                    .animation(store.phase == .loading ?
                        Animation.linear(duration: 1).repeatForever(autoreverses: false) : .default,
                        value: store.phase == .loading)
            }
            .buttonStyle(.plain)
            .keyboardShortcut("r", modifiers: .command)
            Button {
                NSApplication.shared.terminate(nil)
            } label: {
                Image(systemName: "power")
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

struct MenuBarLabel: View {
    let tightest: UsageGauge?

    var body: some View {
        if let gauge = tightest, let fraction = gauge.fractionUsed {
            HStack(spacing: 3) {
                Image(systemName: "gauge.with.needle")
                Text("\(Int((fraction * 100).rounded()))%")
                    .font(.system(size: 11, weight: .semibold, design: .rounded).monospacedDigit())
            }
            .foregroundStyle(GaugeRow.barColor(fraction))
        } else {
            Image(systemName: "gauge.with.needle")
        }
    }
}
