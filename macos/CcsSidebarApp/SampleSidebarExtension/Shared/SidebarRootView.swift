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
    @State private var selection: String?
    @State private var clusterFirst = false
    @State private var clock = WorkingClock()
    @State private var lastFocusedId: String?
    @State private var serverOverride: Int?
    @State private var modifiers = ModifierMonitor()
    private let host: HostIdentity?
    private let port: Int

    public init(port: Int = 8788, host: HostIdentity? = nil) {
        _client = State(initialValue: SnapshotClient(port: port))
        self.host = host
        self.port = port
    }

    /// Built per call rather than stored, because the client may have moved to another server once
    /// the host said which cmux it is; an action sent to the previous one would act on the wrong
    /// window's session.
    private var actionClient: ActionClient { ActionClient(port: client.port) }

    public var body: some View {
        VStack(spacing: 0) {
            SidebarHeader(
                scope: $scope,
                grouping: $grouping,
                query: $query,
                layouts: $layouts,
                clusterFirst: $clusterFirst,
                serverOverride: $serverOverride,
                activePort: client.port,
                adopted: client.adopted,
                counts: client.counts
            )
            Divider()
            if host != nil && !client.adopted {
                NoticeBar(
                    symbol: "questionmark.circle",
                    message: "Showing port \(client.port) — this window's cmux has not been identified yet."
                )
            }
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
        }
        .onAppear {
            restorePreferences()
            client.start()
            clock.start()
            modifiers.start()
            adoptHostServer()
        }
        .onChange(of: scope) { _, next in client.scope = next }
        .onChange(of: grouping) { _, next in Preferences.grouping = next }
        .onChange(of: layouts) { _, next in Preferences.layouts = next }
        .onDisappear {
            client.stop()
            clock.stop()
            modifiers.stop()
        }
        .onChange(of: host?.workspaceIds ?? []) { _, _ in adoptHostServer() }
        .onChange(of: serverOverride) { _, next in client.pinnedPort = next }
        .onChange(of: client.adoptionGeneration) { _, _ in
            // The previous server's rows are gone; a selection pointing into them would keep a
            // row highlighted that this window has never opened.
            selection = nil
            lastFocusedId = nil
        }
        .onChange(of: client.rows) { _, rows in
            clock.observe(rows: rows)
            followExternalFocus(in: rows)
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
                grouping: grouping,
                layouts: layouts,
                port: client.port,
                selection: $selection,
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
                // Selection is set here, before the request, and it is what makes a click feel
                // instant. `focused` is cmux's own state and only turns true once cmux has
                // actually switched, which is why waiting for it looked broken and clicking twice
                // looked fine — the second click landed after the switch. Selection says "this is
                // the row you picked", which is true the moment you pick it.
                selection = row.id
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

    /// Ask the client to follow whichever cmux is hosting this sidebar.
    private func adoptHostServer() {
        guard let host else {
            Diagnostics.note("adoptHostServer: no host identity")
            return
        }
        let ids = host.workspaceIds
        Diagnostics.note("adoptHostServer: host reports \(ids.count) workspaces")
        client.hostWorkspaceIds = ids
        Task { await client.adopt(hostWorkspaceIds: ids) }
    }

    /// Move the selection when something else changed which workspace is focused.
    ///
    /// cmux owns Command-number and the tab bar, so a switch can happen without this sidebar ever
    /// seeing the keystroke. Clicking a row already marks it immediately; this is the other half —
    /// the list should not keep pointing at the row you were on before you left it.
    ///
    /// Only on a change of focus, never on every snapshot: assigning continuously would drag the
    /// selection back on each poll and make arrow-key navigation impossible to hold.
    private func followExternalFocus(in rows: [SidebarRow]) {
        let focused = rows.first(where: \.focused)?.id
        defer { lastFocusedId = focused }
        guard let focused, focused != lastFocusedId else { return }
        selection = focused
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
