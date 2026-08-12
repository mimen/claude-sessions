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
@MainActor
public struct SessionRowView: View {
    public let row: SidebarRow
    public let age: String
    public let actions: RowActions
    public let isSelected: Bool
    public let layout: RowLayout
    public let port: Int

    @State private var hovering = false
    @State private var showingSummary = false
    @State private var hoverTask: Task<Void, Never>?

    public init(
        row: SidebarRow,
        age: String,
        actions: RowActions,
        isSelected: Bool = false,
        layout: RowLayout = .wide,
        port: Int = 8788
    ) {
        self.row = row
        self.age = age
        self.actions = actions
        self.isSelected = isSelected
        self.layout = layout
        self.port = port
    }

    private var titleWeight: Font.Weight { row.section == "needs-you" ? .medium : .regular }

    public var body: some View {
        content
            .contentShape(Rectangle())
            .onTapGesture { actions.open(row) }
            .onHover { inside in
                hovering = inside
                hoverTask?.cancel()
                guard inside else { showingSummary = false; return }
                // A pause, so sweeping down the list does not strobe cards at every row.
                hoverTask = Task {
                    try? await Task.sleep(for: .milliseconds(550))
                    if !Task.isCancelled { showingSummary = true }
                }
            }
            .popover(isPresented: $showingSummary, arrowEdge: .trailing) {
                SummaryCard(row: row)
            }
            // A native menu, so it is free to extend past the sidebar's edge — the constraint the
            // web version could never escape, being painted inside a web view's own viewport.
            .contextMenu { RowContextMenu(row: row, actions: actions) }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 2) {
            if layout == .threeLine { projectLine }
            HStack(spacing: 6) {
                Text(row.name)
                    .font(.system(size: 13, weight: titleWeight))
                    .foregroundStyle(row.isJunk ? AnyShapeStyle(.tertiary) : row.isGhost ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 8)
                // Compact keeps status beside the title, which is exactly what shortens it.
                if layout == .compact, !hovering {
                    statusAndAge
                }
            }

            HStack(spacing: 4) {
                if layout != .threeLine {
                    Image(systemName: "folder")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                    Text(row.directory ?? "—")
                        .lineLimit(1)
                }
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
                if let suggestion = row.suggestion {
                    SuggestionChip(suggestion: suggestion)
                }
                Spacer(minLength: 6)
                if hovering && layout != .threeLine {
                    hoverControls
                } else if layout != .compact {
                    statusAndAge
                }
            }
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(height: layout == .threeLine ? 62 : 46, alignment: .center)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay {
            if isSelected {
                RoundedRectangle(cornerRadius: 6).strokeBorder(.tertiary, lineWidth: 1)
            }
        }
        // The left edge marks the open session, or unread when it is some other row. Focus wins:
        // where a session is matters more than that it has news, and opening it clears the news.
        .overlay(alignment: .leading) { edge }
    }

    /// Only what this row can actually do: a control that is always visible and never able to act
    /// is the thing the web sidebar had to remove.
    private var hoverControls: some View {
        HStack(spacing: 4) {
            if !row.isCompleted {
                RowActionButton(
                    symbol: row.isSaved ? "bookmark.fill" : "bookmark",
                    help: row.isSaved ? "Move to Active" : "Save for later"
                ) { actions.lifecycle(row, row.isSaved ? "unsave" : "save") }
                RowActionButton(symbol: "checkmark", help: "Mark done") {
                    actions.lifecycle(row, "complete")
                }
            }
            if row.hasTab {
                RowActionButton(symbol: "xmark", help: "Close tab") { actions.closeTab(row) }
            }
        }
    }

    /// Project and status above the title, the shape the three-line layout is for.
    private var projectLine: some View {
        HStack(spacing: 4) {
            ProjectMark(faviconUrl: row.faviconUrl, muted: row.isGhost, port: port)
            Text(row.directory ?? "—").lineLimit(1)
            Spacer(minLength: 6)
            if hovering {
                hoverControls
            } else {
                statusAndAge
            }
        }
        .font(.system(size: 10))
        .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var statusAndAge: some View {
        HStack(spacing: 4) {
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

    private var background: some View {
        Group {
            if row.focused { Color.primary.opacity(0.12) }
            else if hovering { Color.primary.opacity(0.10) }
            else if row.isGhost { Color.clear }
            else { Color.primary.opacity(0.06) }
        }
    }

    @ViewBuilder
    private var edge: some View {
        if row.focused {
            Rectangle().fill(.primary).frame(width: 2)
        } else if row.unread > 0 {
            Rectangle().fill(Color(hex: "#4C8DFF") ?? .blue).frame(width: 2)
        }
    }
}

/// One hover control. Small, square, and quiet until pointed at.
struct RowActionButton: View {
    let symbol: String
    let help: String
    let run: () -> Void

    var body: some View {
        Button(action: run) {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .medium))
                .frame(width: 18, height: 18)
                .background(Color.primary.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain)
        .help(help)
    }
}
