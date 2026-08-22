import SwiftUI

@main
struct CcsUsageMenuBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = AppStore.shared

    var body: some Scene {
        MenuBarExtra {
            UsagePanel(store: store)
        } label: {
            MenuBarLabel(tightest: store.tightest)
        }
        .menuBarExtraStyle(.window)
    }
}

enum AppStore {
    static let shared = UsageStore()
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        AppStore.shared.startPolling()
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppStore.shared.stopPolling()
    }
}
