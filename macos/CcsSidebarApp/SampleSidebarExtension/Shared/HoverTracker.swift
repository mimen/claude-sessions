import AppKit
import SwiftUI

/// Whether the pointer is inside one row, answered by AppKit for that row alone.
///
/// The two mechanisms this replaces both failed in their own way inside the extension's remote
/// view. SwiftUI's hover phases arrive only while the pointer MOVES and are dropped often enough
/// that a row could miss its own entry. Polling the pointer and hit-testing it against measured row
/// frames needed the pointer and the frames to be in one coordinate space, which they were not, and
/// asked `window.mouseLocationOutsideOfEventStream` on the extension's window rather than the one
/// the pointer is really in — so it regularly reported the pointer as outside the list and wiped
/// the highlight, with nothing to restore it until the pointer moved again.
///
/// A tracking area is the primitive both were imitating: the window server tells this view when the
/// pointer crosses its edge, in its own bounds, with no arithmetic and no shared state to go stale.
/// `.inVisibleRect` keeps it correct as the row scrolls, and `.activeAlways` keeps it working while
/// cmux is not the key window — the sidebar is something you point at on the way to somewhere else.
struct HoverTracker: NSViewRepresentable {
    let changed: (Bool) -> Void

    func makeNSView(context: Context) -> TrackingView {
        let view = TrackingView()
        view.changed = changed
        return view
    }

    func updateNSView(_ view: TrackingView, context: Context) {
        view.changed = changed
    }

    static func dismantleNSView(_ view: TrackingView, coordinator: ()) {
        // A row torn down while the pointer is inside it never gets its exit, and the highlight
        // would outlive the row it belonged to.
        view.reportExitIfInside()
    }

    final class TrackingView: NSView {
        var changed: ((Bool) -> Void)?
        private var inside = false

        /// Invisible to hit-testing: this sits behind the row's own content and must not take
        /// clicks away from it.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func updateTrackingAreas() {
            for area in trackingAreas { removeTrackingArea(area) }
            addTrackingArea(
                NSTrackingArea(
                    rect: .zero,
                    // `.mouseMoved` as well as entry/exit: an entry event that never arrives —
                    // and in this remote view they do go missing — would otherwise leave the row
                    // unhoverable until something rebuilt it. Any movement inside claims it.
                    options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
                    owner: self
                )
            )
            super.updateTrackingAreas()
            // The list reorders under a resting pointer often enough to matter: a row that slides
            // out from under it never receives an exit, and one that slides beneath it never
            // receives an entry. Re-asking on every layout keeps both honest.
            reconcileWithPointer()
        }

        override func mouseEntered(with event: NSEvent) { report(true) }
        override func mouseMoved(with event: NSEvent) { report(true) }
        override func mouseExited(with event: NSEvent) { report(false) }

        func reportExitIfInside() {
            guard inside else { return }
            inside = false
            changed?(false)
        }

        private func reconcileWithPointer() {
            guard let window, window.isVisible else { return }
            let local = convert(window.mouseLocationOutsideOfEventStream, from: nil)
            report(bounds.contains(local))
        }

        private func report(_ next: Bool) {
            guard next != inside else { return }
            inside = next
            changed?(next)
        }
    }
}
