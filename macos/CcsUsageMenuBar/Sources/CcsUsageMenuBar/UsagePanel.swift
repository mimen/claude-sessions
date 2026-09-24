import SwiftUI

struct UsagePanel: View {
    @ObservedObject var store: UsageStore
    /// ScrollView rasterizes blank under ImageRenderer, so the headless render lays out flat.
    var scrolls = true
    @State private var now = Date()
    private let ticker = Timer.publish(every: 30, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            if scrolls {
                ScrollView { body_ }
            } else {
                body_
            }
            footer
        }
        .frame(width: 320, height: scrolls ? store.panelHeight : nil)
        .onReceive(ticker) { now = $0 }
        .onDisappear { store.dragging = nil }
    }

    private var body_: some View {
        VStack(alignment: .leading, spacing: 2) {
            content
            if !store.notes.isEmpty {
                healthNotes
            }
            if !store.cswapAccounts.isEmpty {
                accountSwitcher
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 4)
    }

    /// Adapters that answered with caveats (stale fallbacks) or not at all.
    private var healthNotes: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(store.notes, id: \.self) { note in
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
            ProviderSectionHeader(provider: section.provider, title: section.title,
                                  highlighted: store.dragging == .section(section.id))
                .reorderable(.section(section.id), store: store, enabled: scrolls)
            if section.account != nil || section.plan != nil {
                HStack(spacing: 5) {
                    if let account = section.account {
                        Text(account)
                            .font(.system(size: 10, weight: .medium, design: .rounded))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    if let plan = section.plan {
                        Text(plan.name)
                            .lineLimit(1)
                            .fixedSize()
                            .font(.system(size: 8.5, weight: .semibold, design: .rounded))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.secondary.opacity(0.14)))
                    }
                    if section.plan != nil {
                        Text(section.renewsOn.map { "renews \(UsageViewEngine.shared.renewalLabel($0))" } ?? "renewal unknown")
                            .lineLimit(1)
                            .fixedSize()
                            .font(.system(size: 9.5, design: .rounded))
                            .foregroundStyle(.tertiary)
                    }
                    let resets = section.rows.compactMap { if case .reset(let r) = $0 { r } else { nil } }
                    if !resets.isEmpty {
                        ResetChip(resets: resets, now: now)
                    }
                    if let staleSince = section.staleSince {
                        Text("stale \(UsageViewEngine.shared.shortAge(Date(epochMs: staleSince), now: now))")
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
            ForEach(section.rows.filter { !$0.isReset }) { row in
                let item = DragItem.row(section: section.id, gauge: row.id)
                GaugeRow(row: row, now: now)
                    .opacity(store.dragging == item ? 0.4 : 1)
                    .reorderable(item, store: store, enabled: scrolls)
            }
        }
    }

    private var sections: [ViewSection] {
        store.sections
    }

    /// Monthly subscription total, pinned above the footer controls.
    private var billFooter: some View {
        HStack(spacing: 4) {
            let bill = store.view?.bill ?? .init(total: 0, planCount: 0)
            Text("≈ \(Int(bill.total.rounded())) USD / mo")
                .font(.system(size: 11, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(.primary)
            Text("across \(bill.planCount) plans")
                .font(.system(size: 9.5))
                .foregroundStyle(.tertiary)
            Spacer()
            if scrolls {
            Toggle("Fable", isOn: $store.showFable)
                .toggleStyle(.checkbox)
                .font(.system(size: 9.5))
                .foregroundStyle(.secondary)
                .help("Show each Claude account's weekly Fable cap")
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
        }
        .padding(.horizontal, 14)
        .padding(.top, 8)
    }

    @ViewBuilder
    private var footerStatus: some View {
        let age = store.lastSuccess.map { UsageViewEngine.shared.shortAge($0, now: now) }
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
    let reading: UsageViewModel.Overall?
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
        case .fiveHour: used = [reading?.fiveHour]
        case .sevenDay: used = [reading?.sevenDay]
        case .both: used = [reading?.fiveHour, reading?.sevenDay]
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

/// Reorders live while hovering, so the list shows where the item will land. Sections
/// only land on sections and rows only on rows of their own section.
struct ReorderDropDelegate: DropDelegate {
    let target: DragItem
    let store: UsageStore

    func dropEntered(info: DropInfo) {
        guard let moving = store.dragging, moving != target else { return }
        withAnimation(.easeInOut(duration: 0.15)) { store.move(moving, onto: target) }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }

    func performDrop(info: DropInfo) -> Bool {
        store.dragging = nil
        return true
    }
}

extension View {
    @ViewBuilder
    func reorderable(_ item: DragItem, store: UsageStore, enabled: Bool = true) -> some View {
        if enabled {
            contentShape(Rectangle())
                .onDrag {
                    store.dragging = item
                    return NSItemProvider(object: "\(item)" as NSString)
                }
                .onDrop(of: [.text], delegate: ReorderDropDelegate(target: item, store: store))
        } else {
            self
        }
    }
}
