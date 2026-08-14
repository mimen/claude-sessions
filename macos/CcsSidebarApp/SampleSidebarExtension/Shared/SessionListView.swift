import SwiftUI

/// The sidebar's list, grouped the way the server already grouped it.
///
/// Sections come from each row's `section`, in first-appearance order, because the server has
/// already sorted the rows into the order it wants them read. Re-sorting here would be a second
/// opinion about priority, and the two would drift.
@MainActor
public struct SessionListView: View {
    private let rows: [SidebarRow]
    private let now: Date
    private let actions: RowActions
    private let selectedId: String?
    private let grouping: GroupingMode
    private let layouts: RowLayouts
    private let port: Int
    private let selection: Binding<String?>?
    private let clusterFirst: Bool
    private let truncated: Bool
    private let clock: WorkingClock
    private let jumpLabels: [String: String]
    private let onJump: (Int) -> Void
    private let scrollTarget: Binding<String?>?
    @State private var collapsed: Set<String> = []
    @FocusState private var listFocused: Bool

    public init(
        rows: [SidebarRow],
        actions: RowActions,
        now: Date = Date(),
        selectedId: String? = nil,
        grouping: GroupingMode = .status,
        layouts: RowLayouts = RowLayouts(),
        port: Int = 8788,
        selection: Binding<String?>? = nil,
        clusterFirst: Bool = false,
        truncated: Bool = false,
        clock: WorkingClock,
        jumpLabels: [String: String] = [:],
        onJump: @escaping (Int) -> Void = { _ in },
        scrollTarget: Binding<String?>? = nil
    ) {
        self.rows = rows
        self.actions = actions
        self.now = now
        self.selectedId = selectedId
        self.grouping = grouping
        self.layouts = layouts
        self.port = port
        self.selection = selection
        self.clusterFirst = clusterFirst
        self.truncated = truncated
        self.clock = clock
        self.jumpLabels = jumpLabels
        self.onJump = onJump
        self.scrollTarget = scrollTarget
    }

    private var sections: [(name: String, rows: [SidebarRow])] {
        Grouping.group(rows: rows, by: grouping, clusterFirst: clusterFirst)
    }

    /// What the arrow keys walk: visible rows in display order, so a shelved section is skipped
    /// rather than selected invisibly.
    private var navigable: [SidebarRow] {
        sections.filter { !collapsed.contains($0.name) }.flatMap(\.rows)
    }

    private func move(by delta: Int) {
        guard let selection, !navigable.isEmpty else { return }
        let ids = navigable.map(\.id)
        let current = selection.wrappedValue.flatMap { ids.firstIndex(of: $0) }
        let next = current.map { min(max($0 + delta, 0), ids.count - 1) } ?? (delta > 0 ? 0 : ids.count - 1)
        selection.wrappedValue = ids[next]
        // Arrow keys can walk past the edge of the view, so this is the one case that must scroll.
        scrollTarget?.wrappedValue = ids[next]
    }

    public var body: some View {
        ScrollViewReader { proxy in
            listBody
                .focusable()
                .focusEffectDisabled()
                .focused($listFocused)
                .onAppear { listFocused = true }
                .onKeyPress(.upArrow) { move(by: -1); return .handled }
                .onKeyPress(.downArrow) { move(by: 1); return .handled }
                // The badges promised these; without a handler they were decoration.
                .onKeyPress(phases: .down) { press in
                    guard press.modifiers.contains(.command),
                          let digit = Int(press.characters), (1...9).contains(digit)
                    else { return .ignored }
                    onJump(digit - 1)
                    return .handled
                }
                .onKeyPress(.return) {
                    if let id = selection?.wrappedValue, let row = navigable.first(where: { $0.id == id }) {
                        actions.open(row)
                    }
                    return .handled
                }
                // Scrolling follows an explicit request, not the selection.
                //
                // Clicking a row selects it, and a row you clicked is by definition already on
                // screen — centring it yanked the list out from under the pointer for no reason.
                // Only movement the reader cannot see coming asks for a scroll.
                .onChange(of: scrollTarget?.wrappedValue) { _, id in
                    guard let id else { return }
                    withAnimation(.easeOut(duration: 0.12)) { proxy.scrollTo(id, anchor: .center) }
                    scrollTarget?.wrappedValue = nil
                }
        }
    }

    private var listBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(sections, id: \.name) { section in
                    Section {
                        ForEach(collapsed.contains(section.name) ? [] : section.rows) { row in
                            SessionRowView(
                                row: row,
                                age: RelativeAge.format(row.lastActivityAt, now: now),
                                actions: actions,
                                isSelected: row.id == (selection?.wrappedValue ?? selectedId),
                                layout: layouts.layout(for: row),
                                port: port,
                                workingFor: clock.elapsed(for: row),
                                jumpLabel: jumpLabels[row.id]
                            )
                            .id(row.id)
                        }
                    } header: {
                        HStack(spacing: 4) {
                            Image(systemName: collapsed.contains(section.name) ? "chevron.right" : "chevron.down")
                                .font(.system(size: 8, weight: .semibold))
                            Text(section.name.uppercased())
                                .font(.system(size: 10, weight: .semibold))
                                .tracking(0.8)
                            Spacer()
                            Text("\(section.rows.count)")
                                .font(.system(size: 10))
                                .monospacedDigit()
                        }
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.top, 10)
                        .padding(.bottom, 2)
                        .contentShape(Rectangle())
                        // Shelving a section is a standing choice about how much you want to see,
                        // so its count stays visible while its rows are away.
                        .onTapGesture {
                            if collapsed.contains(section.name) { collapsed.remove(section.name) }
                            else { collapsed.insert(section.name) }
                        }
                    }
                }
            }
            .padding(8)
            .background(OverlayScrollers().frame(width: 0, height: 0))

            if truncated {
                // A list that silently stopped is worse than one that says it did.
                Text("More sessions exist than this view will show.")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .padding(.bottom, 10)
            }
        }
    }
}
/// Coarse ages. The bands match the web sidebar's so the two read the same at a glance.
public enum RelativeAge {
    public static func format(_ epochMs: Double?, now: Date = Date()) -> String {
        guard let epochMs else { return "" }
        let seconds = now.timeIntervalSince1970 - epochMs / 1000
        if seconds < 90 { return "now" }
        if seconds < 3_600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600))h" }
        if seconds < 604_800 { return "\(Int(seconds / 86_400))d" }
        return "\(Int(seconds / 604_800))w"
    }
}
