import CmuxExtensionKit
import SwiftUI

/// The CCS session sidebar, as a native cmux sidebar extension.
///
/// It asks cmux for nothing but the right to exist: the session list, its ordering and every
/// action come from the CCS server on loopback, not from cmux's workspace model. The read scopes
/// stay minimal for that reason — a scope this extension does not use is a permission the user
/// would be granting for nothing.
@main
final class CcsSidebarExtension: @MainActor CmuxSidebarExtension {
    static let manifest = CmuxExtensionManifest(
        id: "com.milad.ccs.sidebar.Extension",
        displayName: String(localized: "ccsSidebar.manifest.displayName", defaultValue: "CCS Sessions"),
        readScopes: [.workspaceList],
        actionScopes: [.selectWorkspace]
    )

    private let client = SnapshotClient()

    required init() {}

    var body: some View {
        CcsSidebarRootView(client: client)
    }

    func update(context: CmuxSidebarContext) {}

    func connectionStatusDidChange(_ status: CmuxSidebarConnectionStatus) {}
}

struct CcsSidebarRootView: View {
    let client: SnapshotClient

    var body: some View {
        Group {
            if client.rows.isEmpty {
                ContentUnavailableView {
                    Label("No sessions", systemImage: "rectangle.stack")
                } description: {
                    Text(client.lastError.map { "Sidebar server unreachable.\n\($0)" }
                         ?? "Waiting for the sidebar server on 127.0.0.1:8788.")
                }
            } else {
                SessionListView(rows: client.rows)
            }
        }
        .onAppear { client.start() }
        .onDisappear { client.stop() }
    }
}
