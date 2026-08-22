import SwiftUI

struct GaugeRow: View {
    let gauge: UsageGauge
    let now: Date

    static let segmentPalette: [Color] = [.blue, .mint, .orange, .purple, .pink]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(gauge.label)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
                if let window = gauge.windowLabel {
                    Text(window)
                        .font(.system(size: 9, weight: .semibold, design: .rounded))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1.5)
                        .background(Capsule().fill(Color.secondary.opacity(0.15)))
                }
                percentOrBalance
            }

            if let fraction = gauge.fractionUsed {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.secondary.opacity(0.18))
                        if let segments = gauge.breakdown, !segments.isEmpty,
                           let totalUsed = sumOf(segments) {
                            // One bar filled with a colored slice per sub-pool.
                            HStack(spacing: 1) {
                                ForEach(segments) { segment in
                                    Capsule()
                                        .fill(Self.segmentPalette[segment.colorIndex % Self.segmentPalette.count])
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

                if let segments = gauge.breakdown, !segments.isEmpty {
                    legend(segments)
                } else {
                    HStack {
                        if let resets = gauge.resetsAt {
                            Text(resetText(resets, now: now))
                        } else {
                            Text(gauge.exact ? "exact" : "estimated")
                        }
                        Spacer()
                    }
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
                }
            } else if gauge.label == "Banked reset" {
                HStack {
                    Text((gauge.remaining ?? 0) >= 1 ? "ready to redeem" : "none banked")
                    if let expiry = gauge.resetsAt {
                        Text("· expires \(expiryText(expiry, now: now))")
                    }
                    Spacer()
                }
                .font(.system(size: 9.5))
                .foregroundStyle(.tertiary)
            } else if let balance = gauge.remaining {
                HStack {
                    Text("balance \(format(balance))")
                    if let resets = gauge.resetsAt {
                        Text(resetText(resets, now: now))
                    }
                    Spacer()
                }
                .font(.system(size: 9.5))
                .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }

    private func legend(_ segments: [UsageBreakdownSegment]) -> some View {
        HStack(spacing: 8) {
            ForEach(segments) { segment in
                HStack(spacing: 3) {
                    Circle()
                        .fill(Self.segmentPalette[segment.colorIndex % Self.segmentPalette.count])
                        .frame(width: 5, height: 5)
                    Text("\(segment.name) \(segment.fractionUsed.map { "\(Int(($0 * 100).rounded()))%" } ?? "–")")
                }
            }
            Spacer()
        }
        .font(.system(size: 9))
        .foregroundStyle(.secondary)
    }

    private func sumOf(_ segments: [UsageBreakdownSegment]) -> Double? {
        let values = segments.compactMap(\.fractionUsed)
        return values.isEmpty ? nil : values.reduce(0, +)
    }

    private func segmentWidth(_ segment: UsageBreakdownSegment, total: Double) -> Double {
        guard total > 0, let f = segment.fractionUsed else { return 0 }
        return f / total
    }

    @ViewBuilder
    private var percentOrBalance: some View {
        if let fraction = gauge.fractionUsed {
            Text("\(Int((fraction * 100).rounded()))%")
                .font(.system(size: 11.5, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(Self.barColor(fraction))
        } else if gauge.label == "Banked reset", (gauge.remaining ?? 0) >= 1 {
            Text("ready")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .foregroundStyle(.green)
        } else if let balance = gauge.remaining {
            Text("$\(format(balance))")
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
        formatter.allowedUnits = interval > 172_800 ? [.day, .hour] : [.hour, .minute]
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

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(provider)
                .font(.system(size: 10.5, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .kerning(0.8)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.top, 10)
        .padding(.bottom, 3)
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
