import AppKit
import SwiftUI
import Combine
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = AppStore.shared
    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private var cancellables = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        // Launch and restart belong to the LaunchAgent make-app.sh installs; a
        // login item would race it into a second menu bar icon.
        try? SMAppService.mainApp.unregister()

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let button = item.button else { return }
        let labelView = NSHostingView(rootView: MenuBarLabel(reading: store.overallReading, mode: store.overallMode))
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

        store.$gauges.map { _ in () }
            .merge(with: store.$overallMode.map { _ in () })
            .receive(on: RunLoop.main)
            .sink { [weak self] in
                guard let self, let button = self.statusItem?.button else { return }
                labelView.rootView = MenuBarLabel(reading: AppStore.shared.overallReading,
                                                  mode: AppStore.shared.overallMode)
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
            let host = NSHostingController(rootView: UsagePanel(store: store))
            host.sizingOptions = [.preferredContentSize]
            popover.contentViewController = host
        }
        Task { @MainActor in
            AppStore.shared.loadCswapAccountsIfNeeded()
        }
        // The popover only auto-dismisses (.transient) when our app is active;
        // an accessory app stays inactive otherwise and the panel sticks.
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }

    func applicationDidResignActive(_ notification: Notification) {
        popover.performClose(nil)
    }
}

enum AppStore {
    static let shared = UsageStore()
}

// MARK: - entry point

if let i = CommandLine.arguments.firstIndex(of: "--render"), i + 1 < CommandLine.arguments.count {
    // Headless PNG of the panel from a live fetch: the visual check without clicking the menu bar.
    MainActor.assumeIsolated {
        let store = UsageStore()
        if let snapshot = try? UsageFetcher.runBlocking(ccsPath: CcsLocator.resolve(), timeout: 60) {
            store.snapshot = snapshot
            store.lastSuccess = snapshot.generatedAt
            store.phase = .loaded(snapshot.generatedAt ?? Date())
        }
        let renderer = ImageRenderer(content: UsagePanel(store: store, scrolls: false).frame(width: 320))
        renderer.scale = 2
        if let image = renderer.nsImage, let tiff = image.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: CommandLine.arguments[i + 1]))
        }
    }
    exit(0)
}

if CommandLine.arguments.contains("--fetch-once") {
    do {
        let snapshot = try UsageFetcher.runBlocking(ccsPath: CcsLocator.resolve(), timeout: 30)
        let gauges = GaugeBuilder.sections(from: snapshot)
        print("decoded \(snapshot.observations.count) observations -> \(gauges.reduce(0) { $0 + $1.gauges.count }) gauges in \(gauges.count) sections")
        for s in gauges {
            print("  [\(s.provider)\(s.accountDisplay.map { " · \($0)" } ?? "")]")
            for g in s.gauges {
                print("    \(g.label) | \(g.windowLabel ?? "-") | \(g.fractionUsed.map { "\(Int($0 * 100))%" } ?? g.remaining.map { "$\($0)" } ?? "?")")
            }
        }
        let reading = GaugeBuilder.overallReading(gauges)
        func pct(_ v: Double?) -> String { v.map { "\(Int($0 * 100))%" } ?? "nil" }
        print("overall used 5h: \(pct(reading.fiveHour)), 7d: \(pct(reading.sevenDay))")
    } catch {
        print("FETCH FAILED: \(error)")
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
