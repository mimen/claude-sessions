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
                    if !store.adapterNotes.isEmpty {
                        healthNotes
                    }
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
        .onDisappear { store.draggingSection = nil }
    }

    /// Adapters that answered with caveats (stale fallbacks) or not at all.
    private var healthNotes: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(store.adapterNotes, id: \.self) { note in
                HStack(alignment: .top, spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 8.5))
                        .foregroundStyle(.orange)
                        .padding(.top, 1)
                    Text(note)
                        .font(.system(size: 9.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.top, 10)
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
            if store.sections.isEmpty {
                spinner
            } else {
                gaugeList
            }
        case .failed(let message):
            if store.sections.isEmpty {
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
            ProviderSectionHeader(provider: section.provider,
                                  highlighted: store.draggingSection != nil && store.draggingSection != section.id)
                .onDrag {
                    store.draggingSection = section.id
                    return NSItemProvider(object: section.id as NSString)
                }
                .onDrop(of: [.text], delegate: SectionDropDelegate(target: section.id, store: store))
            if section.accountDisplay != nil || section.plan != nil {
                HStack(spacing: 5) {
                    if let account = section.accountDisplay {
                        Text(account)
                            .font(.system(size: 9.5, weight: .medium, design: .rounded))
                            .textCase(.uppercase)
                            .kerning(0.5)
                            .foregroundStyle(.tertiary)
                    }
                    if let subscription = section.subscription {
                        Text(subscription.renewalDisplay.map { "\(subscription.planName) · renews \($0)" }
                            ?? "\(subscription.planName) · renewal unknown")
                            .font(.system(size: 8.5, weight: .semibold, design: .rounded))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.secondary.opacity(0.14)))
                    } else if let plan = section.plan {
                        Text(plan.name)
                            .font(.system(size: 8.5, weight: .semibold, design: .rounded))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.secondary.opacity(0.14)))
                    }
                    if section.isStale {
                        Text(section.staleAge(now: now).map { "stale \($0)" } ?? "stale")
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

    /// Monthly subscription total, pinned above the footer controls.
    private var billFooter: some View {
        HStack(spacing: 4) {
            let bill = GaugeBuilder.monthlyBill(store.sections)
            Text("≈ \(Int(bill.total.rounded())) USD / mo")
                .font(.system(size: 11, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(.primary)
            Text("across \(bill.planCount) plans")
                .font(.system(size: 9.5))
                .foregroundStyle(.tertiary)
            Spacer()
            Picker("", selection: $store.overallMode) {
                ForEach(OverallMode.allCases) { mode in
                    Text(mode.rawValue).tag(mode)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .font(.system(size: 9.5))
            .foregroundStyle(.secondary)
            .fixedSize()
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
    }

    @ViewBuilder
    private var footerStatus: some View {
        let age = store.lastSuccess.map { GaugeBuilder.shortAge($0, now: now) }
        let outdated = store.isOutdated(now: now)
        HStack(spacing: 4) {
            switch store.phase {
            case .loading:
                Text("refreshing…")
            case .failed:
                Text(age.map { "refresh failed · data \($0) old" } ?? "refresh failed")
                    .foregroundStyle(.orange)
            default:
                if let age { Text("updated \(age) ago") }
            }
            if outdated, store.phase != .loading {
                Text("outdated")
                    .font(.system(size: 8.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.orange.opacity(0.14)))
            }
        }
        .font(.system(size: 9.5))
        .foregroundStyle(.tertiary)
        .help(store.phase.failureMessage ?? "")
    }

    private var footer: some View {
        VStack(spacing: 0) {
            billFooter
            HStack(spacing: 10) {
            footerStatus
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
            .padding(.vertical, 6)
        }
        .padding(.vertical, 2)
        .background(.bar)
    }
}

struct MenuBarLabel: View {
    let reading: OverallReading
    let mode: OverallMode

    var body: some View {
        let values = remainings
        if values.isEmpty {
            Image(systemName: "sparkles")
        } else {
            HStack(spacing: 3) {
                Image(systemName: "sparkles")
                ForEach(Array(values.enumerated()), id: \.offset) { i, remaining in
                    if i > 0 {
                        Text("/")
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundStyle(.secondary)
                    }
                    Text("\(Int((remaining * 100).rounded()))%")
                        .font(.system(size: 11, weight: .semibold, design: .rounded).monospacedDigit())
                        .foregroundStyle(Self.labelColor(remaining))
                }
            }
        }
    }

    /// Remaining share (1 - used) per shown window, 5h first, nils dropped.
    private var remainings: [Double] {
        let used: [Double?]
        switch mode {
        case .fiveHour: used = [reading.fiveHour]
        case .sevenDay: used = [reading.sevenDay]
        case .both: used = [reading.fiveHour, reading.sevenDay]
        }
        return used.compactMap { $0.map { 1 - $0 } }
    }

    static func labelColor(_ remaining: Double) -> Color {
        switch remaining {
        case 0.4...: .green
        case 0.15..<0.4: .orange
        default: .red
        }
    }
}

/// Reorders live while hovering, so the list shows where the section will land.
struct SectionDropDelegate: DropDelegate {
    let target: String
    let store: UsageStore

    func dropEntered(info: DropInfo) {
        guard let moving = store.draggingSection else { return }
        withAnimation(.easeInOut(duration: 0.15)) { store.moveSection(moving, onto: target) }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }

    func performDrop(info: DropInfo) -> Bool {
        store.draggingSection = nil
        return true
    }
}
