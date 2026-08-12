import SwiftUI

/// A hex string from the category registry or the model table, as a colour.
///
/// The registry is the authority on these values, so they arrive as `#RRGGBB` and are used
/// unchanged; an unparseable one yields nil rather than a guessed colour, because a wrong hue
/// reads as a different category.
extension Color {
    init?(hex: String?) {
        guard var raw = hex else { return nil }
        if raw.hasPrefix("#") { raw.removeFirst() }
        guard raw.count == 6, let value = UInt32(raw, radix: 16) else { return nil }
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

/// One row: title on its own line, then project, category and model beneath it.
///
/// The layout is the web sidebar's, carried over rather than reinvented — the title spans the row
/// because status beside it was what squeezed it, and a closed row loses its card and its
/// running-process facts while keeping the same grid.
public struct SessionRowView: View {
    public let row: SidebarRow
    public let age: String

    public init(row: SidebarRow, age: String) {
        self.row = row
        self.age = age
    }

    private var titleWeight: Font.Weight { row.section == "needs-you" ? .medium : .regular }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(row.name)
                    .font(.system(size: 13, weight: titleWeight))
                    .foregroundStyle(row.isGhost ? .secondary : .primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 8)
            }

            HStack(spacing: 4) {
                Image(systemName: "folder")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                Text(row.directory ?? "—")
                    .lineLimit(1)
                if let category = row.category, let label = category.compactLabel {
                    Text("·").foregroundStyle(.quaternary)
                    Circle()
                        .fill(Color(hex: category.hex) ?? .secondary)
                        .frame(width: 7, height: 7)
                    Text(label).lineLimit(1)
                }
                if let model = row.model, !row.isGhost {
                    Text("·").foregroundStyle(.quaternary)
                    Text(model.label).foregroundStyle(Color(hex: model.color) ?? .secondary)
                }
                Spacer(minLength: 6)
                if let status = row.status, !row.isGhost {
                    Text(status.label)
                    if let icon = status.icon {
                        Image(systemName: icon)
                            .font(.system(size: 8))
                            .foregroundStyle(Color(hex: status.color) ?? .secondary)
                    }
                }
                Text(age).monospacedDigit()
            }
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(height: 46, alignment: .center)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(row.isGhost ? Color.clear : Color.primary.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        // The left edge marks unread, exactly as the web row does.
        .overlay(alignment: .leading) {
            if row.unread > 0 {
                Rectangle().fill(Color(hex: "#4C8DFF") ?? .blue).frame(width: 2)
            }
        }
    }
}
