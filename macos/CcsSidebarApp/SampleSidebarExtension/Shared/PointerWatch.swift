import AppKit
import SwiftUI

/// The pointer's position over the list, polled from the window server instead of accumulated
/// from enter/exit events.
///
/// Hover built on `.onHover` is event-accumulated state: every enter must be matched by an exit,
/// and inside an ExtensionKit remote view the exits are not reliably delivered — a workspace
/// switch can reattach the hosted view without ever telling the old row the pointer left. Each
/// dropped exit is a permanent latch, so the error only grows with uptime, which is exactly the
/// "fine when reopened, drifts as it runs" shape: closing the sidebar destroyed the latched state
/// wholesale.
///
/// This view owns no such state. On a timer it asks the window where the pointer actually is
/// (`mouseLocationOutsideOfEventStream`, a query, not an event) and reports it in its own flipped
/// coordinates — or nil when the pointer is outside its bounds. Whatever hover was painted a tick
/// ago is irrelevant; the next tick recomputes it from the truth, so a missed event can mislead
/// the screen for at most one tick interval.
struct PointerWatch: NSViewRepresentable {
    /// Pointer location in this view's top-left-origin coordinates, nil when outside.
    let onChange: (CGPoint?) -> Void

    func makeNSView(context: Context) -> WatchView {
        let view = WatchView()
        view.onChange = onChange
        view.startPolling()
        return view
    }

    func updateNSView(_ view: WatchView, context: Context) {
        view.onChange = onChange
    }

    static func dismantleNSView(_ view: WatchView, coordinator: ()) {
        view.stopPolling()
    }

    final class WatchView: NSView {
        var onChange: ((CGPoint?) -> Void)?
        private var timer: Timer?
        private var last: CGPoint?

        // Top-left origin, matching SwiftUI's named coordinate spaces, so a reported point can be
        // compared against row frames without a per-frame flip.
        override var isFlipped: Bool { true }

        // Invisible to hit-testing: this view overlays the whole list, and swallowing clicks
        // would be a worse bug than the one it fixes.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        func startPolling() {
            guard timer == nil else { return }
            // 30 Hz is imperceptibly behind a real pointer for a hover highlight, and the poll is
            // a single window-server query plus a bounds check.
            let timer = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
                self?.tick()
            }
            // .common keeps hover live while a scroll wheel holds the run loop in tracking mode.
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
        }

        func stopPolling() {
            timer?.invalidate()
            timer = nil
        }

        private func tick() {
            let point: CGPoint?
            if let window {
                let inView = convert(window.mouseLocationOutsideOfEventStream, from: nil)
                point = bounds.contains(inView) ? inView : nil
            } else {
                point = nil
            }
            guard point != last else { return }
            last = point
            onChange?(point)
        }
    }
}
