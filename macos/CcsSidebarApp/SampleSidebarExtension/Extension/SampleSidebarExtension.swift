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

    private let host = HostIdentity()

    required init() {}

    var body: some View {
        SidebarRootView(host: host)
    }

    /// cmux's own workspace list, which is how this extension works out which cmux it is in.
    func update(context: CmuxSidebarContext) {
        let ids = Set(context.snapshot.workspaces.map { $0.id.uuidString.uppercased() })
        host.workspaceIds = ids
        Diagnostics.note(
            "update: workspaces=\(ids.count) scopes=\(context.grantedReadScopes.map(\.rawValue).sorted()) "
            + "first=\(ids.sorted().first ?? "none")"
        )
    }

    func connectionStatusDidChange(_ status: CmuxSidebarConnectionStatus) {}
}
