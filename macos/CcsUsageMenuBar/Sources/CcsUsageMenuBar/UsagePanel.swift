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
                    if !store.cswapAccounts.isEmpty {
                        accountSwitcher
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 4)
            }
            footer
        }
        .frame(width: 320, height: store.panelHeight)
        .onReceive(ticker) { now = $0 }
    }

    private var accountSwitcher: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("CLAUDE ACCOUNT")
                .font(.system(size: 10.5, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .kerning(0.8)
                .foregroundStyle(.secondary)
                .padding(.top, 12)
            ForEach(store.cswapAccounts) { account in
                Button {
                    guard !account.isActive else { return }
                    store.switchClaudeAccount(account)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: account.isActive ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(account.isActive ? Color.accentColor : Color.secondary.opacity(0.5))
                        Text(account.displayName)
                            .font(.system(size: 11.5, weight: .medium, design: .rounded))
                        if store.switchingTo == account {
                            ProgressView().controlSize(.mini)
                        }
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(account.isActive || store.switchingTo != nil)
            }
            if let error = store.switchError {
                Text(error)
                    .font(.system(size: 9.5))
                    .foregroundStyle(.orange)
            }
        }
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
        ForEach(sections) { section in
            ProviderSectionHeader(provider: section.provider)
            if let account = section.accountDisplay {
                HStack(spacing: 5) {
                    Text(account)
                        .font(.system(size: 9.5, weight: .medium, design: .rounded))
                        .textCase(.uppercase)
                        .kerning(0.5)
                        .foregroundStyle(.tertiary)
                    if let plan = section.plan {
                        Text(plan.name)
                            .font(.system(size: 8.5, weight: .semibold, design: .rounded))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.secondary.opacity(0.14)))
                    }
                    if section.isStale {
                        Text("stale")
                            .font(.system(size: 8.5, weight: .semibold, design: .rounded))
                            .foregroundStyle(.orange)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.orange.opacity(0.14)))
                    }
                    Spacer()
                }
                .padding(.bottom, 2)
            }
            ForEach(section.gauges) { gauge in
                GaugeRow(gauge: gauge, now: now)
            }
        }
    }

    private var sections: [UsageSection] {
        store.sections
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
    /// Weighted-average remaining share across all allowance gauges.
    let remaining: Double?

    var body: some View {
        if let remaining {
            HStack(spacing: 3) {
                Image(systemName: "sparkles")
                Text("\(Int((remaining * 100).rounded()))%")
                    .font(.system(size: 11, weight: .semibold, design: .rounded).monospacedDigit())
            }
            .foregroundStyle(Self.labelColor(remaining))
        } else {
            Image(systemName: "sparkles")
        }
    }

    static func labelColor(_ remaining: Double) -> Color {
        switch remaining {
        case 0.4...: .green
        case 0.15..<0.4: .orange
        default: .red
        }
    }
}
