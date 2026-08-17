import AppKit
import SwiftUI

/// The sidebar itself: polls, renders, and turns row intents into server calls.
///
/// Actions are optimistic only in the sense that the poll is a second away — nothing is mutated
/// locally, because the server owns lifecycle and the next snapshot is the truth. A failure
/// surfaces the server's own words rather than a generic apology.
@MainActor
public struct SidebarRootView: View {
    @State private var client: SnapshotClient
    @State private var failure: String?
    @State private var pendingDestroy: SidebarRow?
    @State private var destroyDetail: String?
    @State private var scope: SidebarScope = .active
    @State private var grouping: GroupingMode = .status
    @State private var query = ""
    @State private var layouts = RowLayouts()
    @State private var clusterFirst = false
    @State private var clock = WorkingClock()
    @State private var modifiers = ModifierMonitor()
    /// The row the user just clicked, painted focused ahead of the server's confirmation.
    @State private var pendingFocus: FocusOverride?
    private let actionClient: ActionClient
    private let port: Int

    public init(port: Int = SidebarServer.defaultPort) {
        _client = State(initialValue: SnapshotClient(port: port))
        actionClient = ActionClient(port: port)
        self.port = port
    }

    public var body: some View {
        VStack(spacing: 0) {
            SidebarHeader(
                scope: $scope,
                grouping: $grouping,
                query: $query,
                layouts: $layouts,
                clusterFirst: $clusterFirst,
                counts: client.counts
            )
            Divider()
            if !client.livenessReadable {
                NoticeBar(
                    symbol: "bolt.horizontal.circle",
                    message: "cmux liveness unreadable — showing stored sessions only."
                )
            }
            if let failure {
                FailureBanner(message: failure) { self.failure = nil }
            }
            content
                // The list takes whatever is left, so the stack always fills the panel.
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        // Without this the stack asks for only as much height as its contents need, and a panel
        // taller than that centres the difference — which is how the header ends up floating in
        // the middle with the list running off the bottom. It depends on whether rows arrive
        // before the first layout pass, which is why it only happened sometimes.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear {
            restorePreferences()
            client.start()
            clock.start()
            modifiers.start()
        }
        .onChange(of: scope) { _, next in client.scope = next }
        .onChange(of: grouping) { _, next in Preferences.grouping = next }
        .onChange(of: layouts) { _, next in Preferences.layouts = next }
        .onDisappear {
            client.stop()
            clock.stop()
            modifiers.stop()
        }
        .onChange(of: client.rows) { _, rows in
            clock.observe(rows: rows)
            // The server confirming the click's focus retires the optimistic claim; from here the
            // snapshot is the only authority again.
            if let pending = pendingFocus, rows.first(where: \.focused)?.id == pending.id {
                pendingFocus = nil
            }
        }
        .confirmationDialog(
            "Destroy this session?",
            isPresented: Binding(get: { pendingDestroy != nil }, set: { if !$0 { pendingDestroy = nil } }),
            presenting: pendingDestroy
        ) { row in
            Button("Destroy", role: .destructive) { run(.destroy(sessionId: row.sessionId ?? row.id)) }
            Button("Cancel", role: .cancel) { pendingDestroy = nil }
        } message: { _ in
            // The preflight says what else goes with it, because "and its descendants" is the part
            // a person cannot see from the row.
            Text(destroyDetail ?? "This erases the transcript and every record of it. It cannot be undone.")
        }
    }

    @ViewBuilder
    private var content: some View {
        let visible = client.rows.filter { $0.matches(query) }
        if visible.isEmpty {
            ContentUnavailableView {
                Label(client.rows.isEmpty ? "No sessions" : "No matches", systemImage: "rectangle.stack")
            } description: {
                if client.rows.isEmpty {
                    Text(client.lastError.map { "Sidebar server unreachable.\n\($0)" }
                         ?? "Waiting for the sidebar server.")
                } else {
                    Text("Nothing in \(scope.title.lowercased()) matches “\(query)”.")
                }
            }
        } else {
            SessionListView(
                rows: visible,
                actions: actions,
                focusOverride: pendingFocus,
                grouping: grouping,
                layouts: layouts,
                port: port,
                clusterFirst: clusterFirst,
                truncated: client.truncated,
                clock: clock,
                jumpLabels: jumpLabels(for: visible),
                onJump: { index in jump(to: index, in: visible) }
            )
        }
    }

    private var actions: RowActions {
        RowActions(
            open: { row in
                // The click is the best predictor of where focus lands next, so the highlight
                // moves now; the snapshot confirms or, on failure, expiry hands it back.
                pendingFocus = FocusOverride(id: row.id)
                // A workspace row has no session to resume, so opening it means focusing the tab.
                // Posting its row id to /api/open asked for a session that never existed.
                if row.isWorkspaceOnly, let workspaceId = row.workspaceId {
                    run(.focusWorkspace(workspaceId: workspaceId))
                } else {
                    run(.open(sessionId: row.sessionId ?? row.id))
                }
            },
            lifecycle: { row, action in run(.lifecycle(sessionId: row.sessionId ?? row.id, action: action)) },
            declineSuggestion: { row in
                guard let verb = row.suggestion?.verb else { return }
                run(.declineSuggestion(sessionId: row.sessionId ?? row.id, verb: verb))
            },
            pin: { row, pinned in
                guard let workspaceId = row.workspaceId else { return }
                run(.pinWorkspace(workspaceId: workspaceId, pinned: pinned))
            },
            closeTab: { row in
                if row.isWorkspaceOnly, let workspaceId = row.workspaceId {
                    run(.closeWorkspace(workspaceId: workspaceId))
                } else {
                    run(.closeSession(sessionId: row.sessionId ?? row.id))
                }
            },
            setIncognito: { row, on in run(.incognito(sessionId: row.sessionId ?? row.id, incognito: on)) },
            destroy: { row in confirmDestroy(row) },
            copySummary: { row in copy(summary: row) }
        )
    }

    /// Command-number jumps, offered only for the first nine rows on screen.
    ///
    /// Numbered by position rather than by the server's own shortcut field: what ⌘3 should open is
    /// the third row you can see, and the stored shortcut belongs to a workspace that may be
    /// filtered out or sorted elsewhere.
    private func jumpLabels(for rows: [SidebarRow]) -> [String: String] {
        guard modifiers.commandHeld else { return [:] }
        var labels: [String: String] = [:]
        for (index, row) in rows.prefix(9).enumerated() { labels[row.id] = "⌘\(index + 1)" }
        return labels
    }

    /// Command-number opens the row wearing that badge.
    func jump(to index: Int, in rows: [SidebarRow]) {
        guard rows.indices.contains(index) else { return }
        actions.open(rows[index])
    }

    private func restorePreferences() {
        grouping = Preferences.grouping
        layouts = Preferences.layouts
        client.scope = scope
    }

    private func run(_ action: SidebarAction) {
        Task {
            do {
                try await actionClient.perform(action)
                failure = nil
                pendingDestroy = nil
                // The list should catch up with the action, not with the next poll.
                await client.refreshNow()
            } catch let error as ActionFailure {
                failure = error.message
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    private func confirmDestroy(_ row: SidebarRow) {
        pendingDestroy = row
        destroyDetail = nil
        Task {
            let facts = try? await actionClient.destroyPreflight(sessionId: row.sessionId ?? row.id)
            if let descendants = facts?["descendantCount"] as? Int, descendants > 0 {
                destroyDetail = "This erases “\(row.name)” and \(descendants) descendant session(s). It cannot be undone."
            } else {
                destroyDetail = "This erases “\(row.name)” — transcript, catalogue row and index entry. It cannot be undone."
            }
        }
    }

    private func copy(summary row: SidebarRow) {
        guard let summary = row.summary else { return }
        let text = [
            row.name,
            summary.state,
            summary.next.map { "Next: \($0)" },
            summary.remaining.map { "Remaining: \($0)" },
        ].compactMap { $0 }.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// A refusal the server explained, kept until dismissed rather than flashed and lost.
/// A standing condition, stated rather than left to be inferred from a short list.
struct NoticeBar: View {
    let symbol: String
    let message: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol).font(.system(size: 10))
            Text(message).font(.system(size: 11)).lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color.yellow.opacity(0.14))
        .foregroundStyle(.secondary)
    }
}

struct FailureBanner: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10))
            Text(message).font(.system(size: 11)).lineLimit(3)
            Spacer(minLength: 4)
            Button(action: dismiss) { Image(systemName: "xmark").font(.system(size: 9)) }
                .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.orange.opacity(0.18))
        .foregroundStyle(.primary)
    }
}
