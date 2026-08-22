import SwiftUI

struct GaugeRow: View {
    let gauge: UsageGauge
    let now: Date

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
                        Capsule()
                            .fill(Self.barColor(fraction))
                            .frame(width: max(geo.size.width * CGFloat(fraction), 4))
                    }
                }
                .frame(height: 5)

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
            } else if let balance = gauge.remaining {
                Text("balance \(format(balance))")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var percentOrBalance: some View {
        if let fraction = gauge.fractionUsed {
            Text("\(Int((fraction * 100).rounded()))%")
                .font(.system(size: 11.5, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(Self.barColor(fraction))
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
        let interval = date.timeIntervalSince(now)
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = interval > 172_800 ? [.day, .hour] : [.hour, .minute]
        formatter.maximumUnitCount = 2
        formatter.unitsStyle = .abbreviated
        if interval <= 0 { return "reset" }
        return "resets in \(formatter.string(from: interval) ?? "soon")"
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
