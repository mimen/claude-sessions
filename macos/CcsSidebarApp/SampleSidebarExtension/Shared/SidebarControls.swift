import SwiftUI

/// How the queue is arranged. Mirrors the web sidebar's own modes.
public enum GroupingMode: String, CaseIterable, Sendable {
    case status, project, category, recent

    public var title: String {
        switch self {
        case .status: return "By status"
        case .project: return "By project"
        case .category: return "By category"
        case .recent: return "Most recent"
        }
    }
}

/// How much room a row gives its title, chosen separately for open and closed sessions.
///
/// Split because they are not the same decision: a closed row has no status or model, and the
/// long tail of them is what a third line actually costs in scrolling.
public enum RowLayout: String, CaseIterable, Sendable {
    case wide, compact, threeLine

    public var title: String {
        switch self {
        case .wide: return "Wide title"
        case .compact: return "Status beside title"
        case .threeLine: return "Three lines"
        }
    }
}

public struct RowLayouts: Sendable, Equatable {
    public var open: RowLayout
    public var closed: RowLayout

    public init(open: RowLayout = .wide, closed: RowLayout = .wide) {
        self.open = open
        self.closed = closed
    }

    public func layout(for row: SidebarRow) -> RowLayout { row.isGhost ? closed : open }
}

/// The header strip: what to show, how to arrange it, and how a row is drawn.
///
/// Scope, filter and grouping decide *which* rows appear; the display menu decides how one is
/// drawn. Keeping that split is why the layouts live behind their own control rather than as a
/// fifth item in the strip.
@MainActor
public struct SidebarHeader: View {
    @Binding var scope: SidebarScope
    @Binding var grouping: GroupingMode
    @Binding var query: String
    @Binding var layouts: RowLayouts
    let counts: [String: Int]

    public init(
        scope: Binding<SidebarScope>,
        grouping: Binding<GroupingMode>,
        query: Binding<String>,
        layouts: Binding<RowLayouts>,
        counts: [String: Int]
    ) {
        _scope = scope
        _grouping = grouping
        _query = query
        _layouts = layouts
        self.counts = counts
    }

    public var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                TextField("Filter", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 10)) }
                        .buttonStyle(.plain)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color.primary.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 6))

            HStack(spacing: 6) {
                Picker("", selection: $scope) {
                    ForEach(SidebarScope.allCases, id: \.self) { value in
                        Text(scopeTitle(value)).tag(value)
                    }
                }
                .labelsHidden()
                .controlSize(.small)
                .fixedSize()

                Picker("", selection: $grouping) {
                    ForEach(GroupingMode.allCases, id: \.self) { value in
                        Text(value.title).tag(value)
                    }
                }
                .labelsHidden()
                .controlSize(.small)
                .fixedSize()

                Spacer(minLength: 0)

                Menu {
                    Section("Open sessions") {
                        Picker("", selection: $layouts.open) {
                            ForEach(RowLayout.allCases, id: \.self) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    }
                    Section("Closed sessions") {
                        Picker("", selection: $layouts.closed) {
                            ForEach(RowLayout.allCases, id: \.self) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    }
                } label: {
                    Image(systemName: "slider.horizontal.3").font(.system(size: 11))
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Display options")
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    /// The scope carries its own count, so switching is an informed choice rather than a guess.
    private func scopeTitle(_ scope: SidebarScope) -> String {
        let key = scope == .completed ? "completed" : scope.rawValue
        if let count = counts[key] { return "\(scope.title) (\(count))" }
        return scope.title
    }
}
