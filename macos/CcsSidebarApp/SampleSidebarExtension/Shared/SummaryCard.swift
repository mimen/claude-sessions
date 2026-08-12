import SwiftUI

/// The enrichment's account of a session, shown on hover.
///
/// A popover rather than a hand-placed panel: it is a native window, so it is free to sit outside
/// the sidebar's bounds instead of being folded back inside them, and it inherits arrow placement
/// and dismissal from the platform.
struct SummaryCard: View {
    let row: SidebarRow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 5) {
                if let category = row.category, let label = category.compactLabel {
                    Circle().fill(Color(hex: category.hex) ?? .secondary).frame(width: 7, height: 7)
                    Text(label)
                }
                Spacer(minLength: 8)
                if let drift = row.summary?.driftLabel {
                    // Staleness is stated rather than implied: a summary written 70 turns ago
                    // describes a session that no longer exists.
                    Text(drift)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.orange.opacity(0.20))
                        .clipShape(Capsule())
                }
            }
            .font(.system(size: 10))
            .foregroundStyle(.secondary)

            if let summary = row.summary {
                if let state = summary.state { field("Now", state) }
                if let next = summary.next { field("Next", next) }
                if let remaining = summary.remaining { field("Remaining", remaining) }
                if let recommendation = summary.recommendation {
                    field("Verdict", summary.reason.map { "\(recommendation) — \($0)" } ?? recommendation)
                }
            } else {
                Text("No summary yet. Enrichment writes one once the session has said enough to describe.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(width: 320, alignment: .leading)
    }

    private func field(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(.tertiary)
            Text(value).font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The verdict, as a chip on the row.
struct SuggestionChip: View {
    let suggestion: SidebarRow.Suggestion

    private var label: String {
        switch suggestion.verb {
        case "complete", "archive": return "done?"
        case "handoff": return "hand off"
        default: return suggestion.verb
        }
    }

    private var tint: Color {
        switch suggestion.verb {
        case "complete", "archive": return .green
        case "handoff": return .secondary
        default: return .blue
        }
    }

    var body: some View {
        Text(label)
            .font(.system(size: 9, weight: .medium))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(tint.opacity(0.20))
            .foregroundStyle(tint)
            .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}

/// The project's published icon, or a folder when it has none.
struct ProjectMark: View {
    let faviconUrl: String?
    let muted: Bool
    let port: Int

    var body: some View {
        if let path = faviconUrl, let url = URL(string: "http://127.0.0.1:\(port)\(path)") {
            AsyncImage(url: url) { image in
                image.resizable().frame(width: 11, height: 11).clipShape(RoundedRectangle(cornerRadius: 2))
            } placeholder: {
                folder
            }
            .opacity(muted ? 0.55 : 1)
        } else {
            folder
        }
    }

    private var folder: some View {
        Image(systemName: "folder")
            .font(.system(size: 9))
            .foregroundStyle(muted ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.tertiary))
    }
}
