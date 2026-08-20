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
    public let layout: RowLayout
    public let port: Int
    public let workingFor: String?
    public let jumpLabel: String?
    /// Hover is computed by the list from the pointer's polled position, never from this view's
    /// own enter/exit events — those are droppable inside an ExtensionKit remote view, and a
    /// dropped exit latched the row in its hover appearance until the view was destroyed.
    public let isHovered: Bool
    /// The list's override of the snapshot's focus, carried while a click awaits confirmation.
    /// nil means the snapshot's own `focused` stands.
    public let isFocused: Bool?

    @State private var showingSummary = false

    private var hovering: Bool { isHovered }
    private var focused: Bool { isFocused ?? row.focused }

    public init(
        row: SidebarRow,
        age: String,
        actions: RowActions,
        layout: RowLayout = .wide,
        port: Int = SidebarServer.defaultPort,
        workingFor: String? = nil,
        jumpLabel: String? = nil,
        isHovered: Bool = false,
        isFocused: Bool? = nil
    ) {
        self.row = row
        self.age = age
        self.actions = actions
        self.layout = layout
        self.port = port
        self.workingFor = workingFor
        self.jumpLabel = jumpLabel
        self.isHovered = isHovered
        self.isFocused = isFocused
    }

    private var titleWeight: Font.Weight { row.section == "needs-you" ? .medium : .regular }

    public var body: some View {
        content
            .contentShape(Rectangle())
            .onTapGesture { actions.open(row) }
            // A native menu, so it is free to extend past the sidebar's edge — the constraint the
            // web version could never escape, being painted inside a web view's own viewport.
            // `.titleAndIcon` is not decoration: without it AppKit measures these labels as if
            // they were icon-only, sizes the menu to the shortest few, and middle-truncates the
            // rest — "Save for later" arrived as "Sav…later". Stating the style makes the title
            // part of the measured width.
            .contextMenu {
                RowContextMenu(row: row, actions: actions).labelStyle(.titleAndIcon)
            }
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
                    if layout != .threeLine { Text("·").foregroundStyle(.quaternary) }
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
                if row.pinned {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 8))
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 6)
                if layout == .wide {
                    statusAndAge.opacity(hovering ? 0 : 1)
                }
            }
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(height: layout == .threeLine ? 62 : 46, alignment: .center)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .trailing) {
            if let jumpLabel, !hovering {
                Text(jumpLabel)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.background.opacity(0.95))
                    .overlay(Capsule().strokeBorder(.quaternary))
                    .clipShape(Capsule())
                    .padding(.trailing, 10)
            }
            if hovering {
                hoverControls
                    .padding(.trailing, 10)
                    .transition(.opacity)
            }
        }
        .background(background)
        // The edge is drawn inside the clip so it takes the row's corner radius instead of
        // squaring off against it — one shape, not a bar sitting beside a rounded card.
        .overlay(alignment: .leading) { edge }
        .clipShape(Rectangle())

    }

    /// Only what this row can actually do: a control that is always visible and never able to act
    /// is the thing the web sidebar had to remove.
    private var hoverControls: some View {
        HStack(spacing: 4) {
            if !row.isCompleted && !row.isWorkspaceOnly {
                RowActionButton(
                    symbol: row.isSaved ? "bookmark.fill" : "bookmark",
                    help: row.isSaved ? "Move to Active" : "Save for later",
                    tint: .orange
                ) { actions.lifecycle(row, row.isSaved ? "unsave" : "save") }
                RowActionButton(symbol: "checkmark", help: "Mark done", tint: .green) {
                    actions.lifecycle(row, "complete")
                }
            }
            if row.hasTab {
                RowActionButton(symbol: "xmark", help: "Close tab", tint: .red) {
                    actions.closeTab(row)
                }
            }
            if !row.isWorkspaceOnly {
                SummaryButton(showing: $showingSummary, row: row)
            }
        }
    }

    /// Project and status above the title, the shape the three-line layout is for.
    private var projectLine: some View {
        HStack(spacing: 4) {
            ProjectMark(faviconUrl: row.faviconUrl, muted: row.isGhost, port: port)
            Text(row.directory ?? "—").lineLimit(1)
            Spacer(minLength: 6)
            statusAndAge.opacity(hovering ? 0 : 1)
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
            Text(workingFor ?? age).monospacedDigit()
        }
        .font(.system(size: 10))
        .foregroundStyle(.secondary)
    }

    private var background: some View {
        Group {
            // Wide apart on purpose. Focused sat at 0.12 against a resting 0.06, which is a
            // difference you cannot see, so the one state that says where you are read as noise.
            if focused { Color.primary.opacity(0.22) }
            else if hovering { Color.primary.opacity(0.11) }
            else if row.isGhost { Color.clear }
            else { Color.primary.opacity(0.05) }
        }
    }

    @ViewBuilder
    private var edge: some View {
        if focused {
            Rectangle().fill(.primary).frame(width: 3)
        } else if row.unread > 0 {
            Rectangle().fill(Color(hex: "#4C8DFF") ?? .blue).frame(width: 2)
        }
    }
}

/// The summary, opened from its own control rather than from the row.
///
/// Hovering the row was too broad a trigger: reading the list means sweeping the pointer down it,
/// and a card appearing under the pointer mid-sweep covers the rows being read. Reaching this
/// control is deliberate, so it opens with no delay at all.
struct SummaryButton: View {
    @Binding var showing: Bool
    let row: SidebarRow

    @State private var hovering = false

    var body: some View {
        Image(systemName: "text.alignleft")
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(hovering ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            .frame(width: 18, height: 18)
            .background(Color.primary.opacity(hovering ? 0.24 : 0.10))
            .contentShape(Rectangle())
            .onHover { inside in
                hovering = inside
                showing = inside
            }
            .popover(isPresented: $showing, arrowEdge: .trailing) {
                SummaryCard(row: row)
            }
            .help("Summary")
    }
}

/// One hover control. Small, square, and quiet until pointed at.
struct RowActionButton: View {
    let symbol: String
    let help: String
    let tint: Color
    let run: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: run) {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .medium))
                // Colour carries the meaning at rest; the pointer makes the target unmistakable.
                .foregroundStyle(hovering ? AnyShapeStyle(tint) : AnyShapeStyle(tint.opacity(0.75)))
                .frame(width: 18, height: 18)
                .background(tint.opacity(hovering ? 0.28 : 0.12))
                .clipShape(Rectangle())
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
    }
}
