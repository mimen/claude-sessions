import SwiftUI

struct GaugeRow: View {
    let row: ViewRow
    let now: Date

    static let segmentPalette: [Color] = [.blue, .mint, .orange, .purple, .pink]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.label)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                if case .allowance(let r) = row, let window = r.window {
                    Text(window)
                        .font(.system(size: 9, weight: .semibold, design: .rounded))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1.5)
                        .background(Capsule().fill(Color.secondary.opacity(0.15)))
                }
                percentOrBalance
            }
            detail
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var detail: some View {
        switch row {
        case .allowance(let r):
            if let fraction = r.fractionUsed {
                bar(fraction, segments: r.segments)
                if !r.segments.isEmpty {
                    legend(r.segments)
                }
                if let resets = r.resetsAt {
                    HStack {
                        Text(resetText(Date(epochMs: resets), now: now))
                        Spacer()
                    }
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
                }
            }
        case .reset(let r):
            HStack {
                Text(r.available ? "ready to redeem" : "none banked")
                if let expiry = r.expiresAt {
                    Text("· expires \(expiryText(Date(epochMs: expiry), now: now))")
                }
                Spacer()
            }
            .font(.system(size: 9.5))
            .foregroundStyle(.tertiary)
        case .credit(let r):
            HStack {
                Text("balance \(format(r.balance))")
                if let resets = r.resetsAt {
                    Text(resetText(Date(epochMs: resets), now: now))
                }
                Spacer()
            }
            .font(.system(size: 9.5))
            .foregroundStyle(.tertiary)
        }
    }

    private func bar(_ fraction: Double, segments: [ViewSegment]) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.18))
                if !segments.isEmpty, let totalUsed = sumOf(segments) {
                    // One bar filled with a colored slice per sub-pool.
                    HStack(spacing: 1) {
                        ForEach(Array(segments.enumerated()), id: \.offset) { i, segment in
                            Capsule()
                                .fill(Self.segmentColor(i))
                                .frame(width: max(geo.size.width * CGFloat(fraction) * CGFloat(segmentWidth(segment, total: totalUsed)), 3))
                        }
                    }
                    .padding(.horizontal, 1.5)
                    .frame(width: max(geo.size.width * CGFloat(fraction), 6), height: geo.size.height, alignment: .leading)
                    .background(Capsule().fill(Self.barColor(fraction).opacity(0.35)))
                    .clipShape(Capsule())
                } else {
                    Capsule()
                        .fill(Self.barColor(fraction))
                        .frame(width: max(geo.size.width * CGFloat(fraction), 4))
                }
            }
        }
        .frame(height: 5)
    }

    private func legend(_ segments: [ViewSegment]) -> some View {
        HStack(spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { i, segment in
                HStack(spacing: 3) {
                    Circle()
                        .fill(Self.segmentColor(i))
                        .frame(width: 5, height: 5)
                    Text("\(segment.name) \(segment.fractionUsed.map { "\(Int(($0 * 100).rounded()))%" } ?? "–")")
                }
            }
            Spacer()
        }
        .font(.system(size: 9))
        .foregroundStyle(.secondary)
    }

    static func segmentColor(_ index: Int) -> Color { segmentPalette[index % segmentPalette.count] }

    private func sumOf(_ segments: [ViewSegment]) -> Double? {
        let values = segments.compactMap(\.fractionUsed)
        return values.isEmpty ? nil : values.reduce(0, +)
    }

    private func segmentWidth(_ segment: ViewSegment, total: Double) -> Double {
        guard total > 0, let f = segment.fractionUsed else { return 0 }
        return f / total
    }

    @ViewBuilder
    private var percentOrBalance: some View {
        switch row {
        case .allowance(let r):
            if let fraction = r.fractionUsed {
                Text("\(Int((fraction * 100).rounded()))%")
                    .font(.system(size: 11.5, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(Self.barColor(fraction))
            }
        case .reset(let r):
            if r.available {
                Text("ready")
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .foregroundStyle(.green)
            }
        case .credit(let r):
            Text(r.unit == "USD" ? "$\(format(r.balance))" : format(r.balance))
                .font(.system(size: 11.5, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(.primary)
        }
    }


    static func barColor(_ fraction: Double) -> Color {
        switch fraction {
        case ..<0.6: .green
        case ..<0.85: .orange
        default: .red
        }
    }

    private func resetText(_ date: Date, now: Date) -> String {
        "resets in \(relative(date, now: now))"
    }

    private func expiryText(_ date: Date, now: Date) -> String {
        relative(date, now: now)
    }

    private func relative(_ date: Date, now: Date) -> String {
        let interval = date.timeIntervalSince(now)
        let formatter = DateComponentsFormatter()
        // Days+hours for anything a day or longer; hours+minutes below that.
        formatter.allowedUnits = interval >= 86_400 ? [.day, .hour] : [.hour, .minute]
        formatter.maximumUnitCount = 2
        formatter.unitsStyle = .abbreviated
        if interval <= 0 { return "now" }
        return formatter.string(from: interval) ?? "soon"
    }

    private func format(_ value: Double) -> String {
        value >= 100 ? String(format: "%.0f", value) : String(format: "%.2f", value)
    }
}

struct ProviderSectionHeader: View {
    let provider: String
    let title: String
    var highlighted = false

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(title)
                .font(.system(size: 10.5, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .kerning(0.8)
                .foregroundStyle(.secondary)
            Spacer()
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.tertiary)
                .help("Drag to reorder")
        }
        .padding(.top, 10)
        .padding(.bottom, 3)
        .opacity(highlighted ? 0.4 : 1)
    }

    var color: Color {
        switch provider {
        case "anthropic": .orange
        case "codex": .teal
        case "grok": Color(nsColor: NSColor.systemGray)
        case "opencode-go": .blue
        case "venice": .purple
        default: .accentColor
        }
    }
}

/// An account's banked resets as one chip on the account line: the redeemable count, and the
/// soonest expiry, with every expiry listed on hover.
struct ResetChip: View {
    let resets: [ViewRow.Reset]
    let now: Date

    private var ready: [ViewRow.Reset] { resets.filter(\.available) }

    var body: some View {
        let live = !ready.isEmpty
        HStack(spacing: 3) {
            Image(systemName: "arrow.counterclockwise")
                .font(.system(size: 7.5, weight: .bold))
            Text(label)
        }
        .font(.system(size: 8.5, weight: .semibold, design: .rounded))
        .lineLimit(1)
        .fixedSize()
        .foregroundStyle(live ? Color.green : Color.secondary)
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(Capsule().fill((live ? Color.green : Color.secondary).opacity(0.14)))
        .help(resets.map { r in
            "\(r.available ? "Ready" : "Used")\(r.expiresAt.map { " · expires in \(Self.left(Date(epochMs: $0), now: now))" } ?? "")"
        }.joined(separator: "\n"))
    }

    private var label: String {
        let count = ready.count
        let noun = count > 1 ? "\(count) resets" : count == 1 ? "reset" : "resets used"
        let soonest = ready.compactMap(\.expiresAt).min()
        return soonest.map { "\(noun) · \(Self.left(Date(epochMs: $0), now: now))" } ?? noun
    }

    /// "10d" / "5h": time left before an expiry.
    static func left(_ date: Date, now: Date) -> String {
        let seconds = date.timeIntervalSince(now)
        guard seconds > 0 else { return "expired" }
        return seconds >= 86_400 ? "\(Int(seconds / 86_400))d" : "\(max(1, Int(seconds / 3_600)))h"
    }
}
