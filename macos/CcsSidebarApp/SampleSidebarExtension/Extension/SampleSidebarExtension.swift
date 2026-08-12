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

    required init() {}

    var body: some View {
        SidebarRootView()
    }

    func update(context: CmuxSidebarContext) {}

    func connectionStatusDidChange(_ status: CmuxSidebarConnectionStatus) {}
}
