import AppKit
import SwiftUI
import Combine

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = AppStore.shared
    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private var cancellables = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = item.button else { return }
        let labelView = NSHostingView(rootView: MenuBarLabel(tightest: nil))
        let ideal = labelView.fittingSize
        let barHeight = NSStatusBar.system.thickness
        labelView.frame = NSRect(x: 0, y: (barHeight - ideal.height) / 2,
                                 width: max(ideal.width, 20), height: min(barHeight, max(ideal.height, 16)))
        button.addSubview(labelView)
        button.frame.size.width = labelView.frame.width + 14
        button.action = #selector(togglePanel)
        button.target = self
        statusItem = item

        popover.contentSize = NSSize(width: 320, height: 420)
        popover.behavior = .transient
        popover.animates = false

        store.$gauges
            .receive(on: RunLoop.main)
            .sink { [weak self] gauges in
                guard let self, let button = self.statusItem?.button else { return }
                labelView.rootView = MenuBarLabel(tightest: GaugeBuilder.tightest(gauges))
                let width = labelView.fittingSize.width
                labelView.frame.size.width = max(width, 20)
                button.frame.size.width = max(width, 20) + 14
            }
            .store(in: &cancellables)

        store.startPolling()
    }

    func applicationWillTerminate(_ notification: Notification) {
        store.stopPolling()
    }

    @objc private func togglePanel() {
        guard let button = statusItem?.button else { return }
        if popover.isShown {
            popover.performClose(nil)
            return
        }
        if popover.contentViewController == nil {
            popover.contentViewController = NSHostingController(rootView: UsagePanel(store: store))
        }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }
}

enum AppStore {
    static let shared = UsageStore()
}

// MARK: - entry point

if CommandLine.arguments.contains("--fetch-once") {
    do {
        let snapshot = try UsageFetcher.runBlocking(ccsPath: CcsLocator.resolve(), timeout: 30)
        let gauges = GaugeBuilder.build(from: snapshot)
        print("decoded \(snapshot.observations.count) observations -> \(gauges.count) gauges")
        for g in gauges.prefix(5) { print("  \(g.provider) | \(g.label) | \(g.windowLabel ?? "-") | \(g.fractionUsed.map { "\(Int($0 * 100))%" } ?? g.remaining.map { "$\($0)" } ?? "?")") }
        print("tightest: \(GaugeBuilder.tightest(gauges)?.label ?? "nil")")
    } catch {
        print("FETCH FAILED: \(error)")
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
